//! `jobs`, `fg`, `bg`, `disown`, `suspend`: the job table of this shell
//! (bash `jobs.def`, `fg_bg.def`, `suspend.def` and the job printing of
//! `jobs.c`). Job control (`set -m`) is active in the shell and in its
//! command substitutions, never in other subshells (bash
//! `without_job_control`).

use std::io::Write as _;

use bstr::{BString, ByteSlice};

use super::{Control, Ctx, Need, Outcome, R, Wait, dirstack, done, number, opts};
use crate::bash::{
	ControlHandle, Platform,
	diag::Diag,
	event::{EventData, WaitKey},
	signal::{SigTarget, Signal},
	store::OptId,
	vm::{
		exec::push_script,
		expand::Stop,
		jobctl, killed,
		proc::{Job, JobLookup, JobProc, JobState, LastBg, ProcState, ScriptKind, Vproc},
		quote,
	},
};

/// Whether job control is active in this vproc (bash `job_control`): `set
/// -m` in the shell or in a command substitution of it. `fg`, `bg`,
/// `suspend` and `wait` (stopped jobs) depend on it.
pub fn active(ctx: &mut Ctx<'_, '_>) -> Result<bool, Need> {
	Ok(!ctx.vp.jobs.subshell && ctx.option(OptId::Monitor)?)
}

/// Why a job spec named no job.
pub enum Bad {
	/// No such job; the caller reports it (bash `sh_badjob`).
	Missing,
	/// The name matches several jobs; already reported.
	Ambiguous,
}

/// Resolve the job spec `word` (bash `get_job_spec`) to a job number. A
/// word without the leading `%` draws bash's warning and is used anyway.
/// Called by the job builtins, `kill` and `wait`.
pub fn spec(ctx: &mut Ctx<'_, '_>, word: &[u8]) -> Result<u32, Bad> {
	if word.is_empty() {
		return Err(Bad::Missing);
	}
	let rest = if let Some(rest) = word.strip_prefix(b"%") {
		rest
	} else {
		ctx.err(Diag::Warning {
			msg: format!("warning: {}: job specification requires leading `%'", word.as_bstr()).into(),
		});
		word
	};
	match ctx.vp.jobs.lookup(rest) {
		JobLookup::Job(n) if ctx.vp.jobs.get(n).is_some() => Ok(n),
		JobLookup::Ambiguous => {
			let name = rest.strip_prefix(b"?").unwrap_or(rest);
			ctx.usage(format!("{}: ambiguous job spec", name.as_bstr()));
			Err(Bad::Ambiguous)
		},
		JobLookup::Job(_) | JobLookup::None => Err(Bad::Missing),
	}
}

/// `NAME: WORD: no such job` (bash `sh_badjob`).
pub fn no_such_job(ctx: &mut Ctx<'_, '_>, word: &[u8]) {
	ctx.usage(format!("{}: no such job", word.as_bstr()));
}

/// bash `printable_job_status` of a job in `jobs`' one line; `long` is
/// `jobs -l`, where a stopped job shows the stop signal's description. A
/// finished job shows how its last process ended (`print_pipeline`'s
/// `last`: [`Job::procs`]' last, under `pipefail` too, where the job's
/// status is another's), else how the job did (killed by its
/// [`Job::signal`], else exited with its status): an exit with 137 is
/// `Exit 137`, a `KILL` is `Killed`.
fn status_text(job: &Job, long: bool, posix: bool, platform: Platform) -> String {
	match job.state {
		JobState::Running => String::from("Running"),
		JobState::Stopped(sig) if long => sig.description(platform),
		JobState::Stopped(sig) if posix => format!("Stopped(SIG{sig})"),
		JobState::Stopped(_) => String::from("Stopped"),
		JobState::Done(status) => {
			let last = job.procs.as_deref().and_then(|procs| procs.list.last());
			let end = last.map_or_else(|| ProcState::ended(status, job.signal), |p| p.state);
			killed::ended_text(end, posix, platform)
		},
	}
}

/// How process `p` of a job in state `job` shows in `jobs -l` (bash
/// `printable_job_status` with `JLIST_LONG`): `Running` for each one of a
/// running job (one stopped too), else how it is: the description of the
/// signal that stopped it ([`ProcState::Stopped`]; the job's for one the
/// record holds as running) or how it ended.
fn process_text(job: JobState, p: ProcState, posix: bool, platform: Platform) -> String {
	match (job, p) {
		(JobState::Running, _) => String::from("Running"),
		(JobState::Stopped(sig), ProcState::Running) => sig.description(platform),
		(_, state) => killed::ended_text(state, posix, platform),
	}
}

/// How `jobs` prints (bash `JLIST_*`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Form {
	Standard,
	/// `-l`: with the pid.
	Long,
	/// `-p`: the pid only.
	Pids,
	/// `-n`: jobs whose state was not reported yet.
	Changed,
}

/// What `jobs` prints a line for besides its text.
pub struct Show<'h> {
	/// `set -o posix` (`Done(N)`, `Stopped(SIGTSTP)`).
	pub posix:    bool,
	/// `$HOME`, for the `(wd: …)` note.
	pub home:     Option<&'h [u8]>,
	/// The signal numbers and descriptions.
	pub platform: Platform,
}

/// One `jobs` entry for job `number` (bash `pretty_print_job`), marking the
/// job reported (`-p` does not): one line, or with `-l` one line for each
/// of its processes ([`Job::procs`], bash `print_pipeline` with
/// `JLIST_LONG`), ` &` and the `(wd: …)` note after the last command. `-p`
/// prints the pid of the job's first process (bash's `pipe->pid`, the
/// process group's leader), not `$!`'s, which names the last one.
fn print_job(ctx: &mut Ctx<'_, '_>, number: u32, form: Form, show: &Show<'_>) {
	let Some(job) = ctx.vp.jobs.get(number) else {
		return;
	};
	if form == Form::Pids {
		let first = job.procs.as_deref().and_then(|procs| procs.list.first());
		let line = format!("{}\n", first.map_or_else(|| job.pid(), JobProc::pid));
		ctx.out(line.as_bytes());
		return;
	}
	if form == Form::Changed && job.notified {
		return;
	}
	if let Some(line) = job_line(ctx.vp, number, form == Form::Long, show) {
		ctx.out(&line);
	}
	if let Some(job) = ctx.vp.jobs.get_mut(number) {
		job.notified = true;
	}
}

/// Job `number`'s `jobs` line (bash `pretty_print_job` with
/// `JLIST_STANDARD`, or with `long` `JLIST_LONG`, one line for each of its
/// processes): `[n]+  `, how it is ([`status_text`], from how the job and
/// its processes ended, never from its status alone) padded to bash's
/// column, then its command. Also the line of bash's notice of a job that
/// stopped or ended in the background ([`jobctl::notice_line`]). `None`
/// when there is no such job.
pub fn job_line(vp: &Vproc, number: u32, long: bool, show: &Show<'_>) -> Option<Vec<u8>> {
	let job = vp.jobs.get(number)?;
	let mark = if vp.jobs.current == Some(number) {
		'+'
	} else if vp.jobs.previous == Some(number) {
		'-'
	} else {
		' '
	};
	let mut tail = Vec::new();
	if job.state == JobState::Running {
		tail.extend_from_slice(b" &");
	}
	if job.wd != vp.cwd {
		tail.extend_from_slice(b"  (wd: ");
		tail.extend_from_slice(&dirstack::polite(show.home, &job.wd, false));
		tail.push(b')');
	}
	let (posix, platform) = (show.posix, show.platform);
	let shown = |p| process_text(job.state, p, posix, platform);
	let each = match job.procs.as_deref() {
		Some(procs) if long => killed::process_lines(&procs.list, shown, &tail),
		_ => None,
	};
	let (pid, status, text) = each.unwrap_or_else(|| {
		(job.pid(), status_text(job, long, posix, platform), [job.text.as_slice(), &tail].concat())
	});
	let mut line = Vec::with_capacity(64 + text.len());
	let _ = write!(line, "[{number}]{mark} ");
	if long {
		let _ = write!(line, "{pid:5} ");
	} else {
		line.push(b' ');
	}
	line.extend_from_slice(status.as_bytes());
	line.resize(line.len() + killed::padding(&status), b' ');
	line.extend_from_slice(&text);
	line.push(b'\n');
	Some(line)
}

/// Forget finished jobs whose state was reported (bash
/// `cleanup_dead_jobs`, which deletes none while the job list is frozen).
fn cleanup(ctx: &mut Ctx<'_, '_>) {
	if ctx.vp.mode.dialect() == crate::bash::ids::Dialect::Bash {
		super::super::killed::cleanup_dead_jobs(ctx.vp);
	} else {
		ctx.vp
			.jobs
			.remove_where(|j| j.notified && matches!(j.state, JobState::Done(_)));
	}
}

/// bash's `notify_and_cleanup (-1)` as `jobs` ends: the background jobs a
/// signal killed that it did not list are reported through its own
/// standard error, and go (`killed::jobs_ended`).
fn ended(ctx: &mut Ctx<'_, '_>) {
	let line = ctx.line;
	if let Some(bytes) = super::super::killed::jobs_ended(ctx.k, ctx.cx, ctx.vp, line) {
		ctx.out_fd(2, &bytes);
	}
}

/// `jobs [-lnprs] [jobspec …]`, `jobs -x command [args]`: list jobs as
/// `[N]±  Status  command`; finished jobs are listed once, then forgotten.
pub fn jobs(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"lpnxrs", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let mut form = Form::Standard;
	let mut execute = false;
	// `Some(true)`: stopped jobs only (`-s`); `Some(false)`: running (`-r`).
	let mut state = None;
	for &(c, ..) in &o.flags {
		match c {
			b'l' => form = Form::Long,
			b'p' => form = Form::Pids,
			b'n' => form = Form::Changed,
			b'x' => {
				if form != Form::Standard {
					ctx.usage("no other options allowed with `-x'");
					return done(1);
				}
				execute = true;
			},
			b'r' => state = Some(false),
			b's' => state = Some(true),
			_ => {},
		}
	}
	if execute {
		return execute_with_pids(ctx, o.rest);
	}
	// A job `jobs` finds done is one bash's `jobs` shows done only once it
	// reaped it ([`crate::bash::store::Job::unreaped`]).
	let finished: Vec<u32> = ctx
		.vp
		.jobs
		.iter()
		.filter(|j| j.unreaped && matches!(j.state, JobState::Done(_)))
		.map(|j| j.number)
		.collect();
	for n in finished {
		if let Some(job) = ctx.vp.jobs.get_mut(n) {
			job.unreaped = false;
		}
	}
	let home = ctx.scalar(b"HOME")?;
	let show = Show {
		posix:    ctx.option(OptId::Posix)?,
		home:     home.as_ref().map(|h| h.as_slice()),
		platform: ctx.k.engine.config().platform,
	};
	if o.rest.is_empty() {
		cleanup(ctx);
		let picked: Vec<u32> = ctx
			.vp
			.jobs
			.iter()
			.filter(|j| match state {
				None => true,
				Some(true) => matches!(j.state, JobState::Stopped(_)),
				Some(false) => j.state == JobState::Running,
			})
			.map(|j| j.number)
			.collect();
		if matches!(form, Form::Long | Form::Pids) {
			settled(ctx, &picked)?;
		}
		for number in picked {
			print_job(ctx, number, form, &show);
		}
		// bash's `-r` and `-s` listings return without `notify_and_cleanup`.
		if state.is_none() {
			cleanup(ctx);
			ended(ctx);
		}
		return done(0);
	}
	if matches!(form, Form::Long | Form::Pids) {
		let named: Vec<u32> = o
			.rest
			.iter()
			.filter_map(|w| {
				match ctx
					.vp
					.jobs
					.lookup(w.strip_prefix(b"%").unwrap_or(w.as_slice()))
				{
					JobLookup::Job(n) => Some(n),
					JobLookup::None | JobLookup::Ambiguous => None,
				}
			})
			.collect();
		settled(ctx, &named)?;
	}
	let mut status = 0;
	for word in o.rest {
		if let Ok(number) = spec(ctx, word) {
			print_job(ctx, number, form, &show);
			cleanup(ctx);
		} else {
			no_such_job(ctx, word);
			status = 1;
		}
	}
	cleanup(ctx);
	ended(ctx);
	done(status)
}

/// Wait until each job of `numbers` has settled on the pid it is known by
/// (its program's OS pid or its virtual pid, [`crate::bash::vm::proc::Bang`])
/// before `jobs -l`/`-p`/`-x` shows it: the builtin runs again then.
fn settled(ctx: &Ctx<'_, '_>, numbers: &[u32]) -> Result<(), Need> {
	let pending = numbers
		.iter()
		.filter_map(|&n| ctx.vp.jobs.get(n))
		.find(|j| j.os_pid.is_none() && ctx.k.bang_pending(j.vpid));
	match pending {
		Some(job) => Err(Need::Sub(Stop::Wait(WaitKey::Proc(job.vpid)))),
		None => Ok(()),
	}
}

/// `jobs -x command [args]`: run the command with every valid `%job`
/// argument replaced by the job's process group id (a bad spec stays as
/// written); the words are not expanded again.
fn execute_with_pids(ctx: &mut Ctx<'_, '_>, words: &[BString]) -> R {
	if words.is_empty() {
		return done(0);
	}
	let named: Vec<u32> = words
		.iter()
		.filter_map(|w| match ctx.vp.jobs.lookup(w.strip_prefix(b"%")?) {
			JobLookup::Job(n) => Some(n),
			JobLookup::None | JobLookup::Ambiguous => None,
		})
		.collect();
	settled(ctx, &named)?;
	let mut src = Vec::new();
	for word in words {
		if !src.is_empty() {
			src.push(b' ');
		}
		let pid = if word.starts_with(b"%") {
			spec(ctx, word)
				.ok()
				.and_then(|n| ctx.vp.jobs.get(n))
				.map(|j| j.pid().to_string())
		} else {
			None
		};
		match pid {
			Some(pid) => src.extend_from_slice(pid.as_bytes()),
			None => src.extend_from_slice(&quote::sh_single_quote(word)),
		}
	}
	ctx.vp.status = 0;
	push_script(ctx.vp, &src, ctx.line, ScriptKind::Eval);
	// bash runs it with `execute_command`, reading no input line: it reports
	// no job ([`crate::bash::vm::killed::line_read`]).
	crate::bash::vm::exec::script_reads_no_line(ctx.vp);
	ctx.k.emit_op(ctx.cx, ctx.vp, 0, EventData::EvalEnter);
	Ok(Outcome { status: 0, control: Control::Frame })
}

/// `fg [jobspec]` / `bg [jobspec …]`, and a `%jobspec [&]` command (`argv`
/// starts with the spec): resume a job in the foreground (print its
/// command, continue it if stopped, wait for it) or in the background
/// (print `[N]± command &`, continue it). Without job control bash refuses
/// with `no job control`.
pub fn fg_bg(ctx: &mut Ctx<'_, '_>, argv: &[BString]) -> R {
	let fg = ctx.name == "fg";
	if !active(ctx)? {
		ctx.usage("no job control");
		return done(1);
	}
	let args = if argv[0].starts_with(b"%") {
		argv
	} else {
		// bash `no_options`: `--` is skipped, any option is invalid.
		match opts(ctx, &argv[1..], b"", b"", false) {
			Ok(o) => o.rest,
			Err(st) => return done(st),
		}
	};
	if fg {
		// `fg %1 &` (and `%1 &`) puts the job in the background.
		if args.last().is_some_and(|a| a.as_slice() == b"&") {
			return done(background(ctx, args.first()));
		}
		return foreground(ctx, args.first());
	}
	let mut status = if args.is_empty() {
		background(ctx, None)
	} else {
		0
	};
	for word in args {
		status |= background(ctx, Some(word));
	}
	done(status)
}

/// The job `word` names (the current job without one) for `fg`/`bg`, with
/// bash's checks: it exists, started under job control, is a child of
/// this shell and has not finished. `Err` holds the status (the reason is
/// reported).
fn movable(ctx: &mut Ctx<'_, '_>, word: Option<&BString>) -> Result<u32, i32> {
	let found = match word {
		Some(word) => spec(ctx, word),
		None => ctx
			.vp
			.jobs
			.current
			.filter(|&n| ctx.vp.jobs.get(n).is_some())
			.ok_or(Bad::Missing),
	};
	let number = match found {
		Ok(n) => n,
		Err(Bad::Missing) => {
			no_such_job(ctx, word.map_or(&b"current"[..], |w| w.as_slice()));
			return Err(1);
		},
		Err(Bad::Ambiguous) => return Err(1),
	};
	let job = ctx.vp.jobs.get(number).expect("found above");
	if !job.control {
		ctx.usage(format!("job {number} started without job control"));
		return Err(1);
	}
	if job.inherited {
		ctx.usage("no current jobs");
		return Err(1);
	}
	if matches!(job.state, JobState::Done(_)) {
		ctx.usage("job has terminated");
		return Err(1);
	}
	Ok(number)
}

/// Continue job `number` if it is stopped (bash `killpg (pgrp, SIGCONT)` and
/// `set_job_running`).
fn resume(ctx: &mut Ctx<'_, '_>, number: u32) {
	let Some(job) = ctx.vp.jobs.get_mut(number) else {
		return;
	};
	if matches!(job.state, JobState::Stopped(_)) {
		job.set_running();
		let id = job.id;
		ControlHandle(ctx.k.ctl.clone()).signal(SigTarget::Job(id), Signal::Cont);
	}
}

/// The `(wd: dir)` note bash adds when a job started elsewhere.
fn wd_note(ctx: &mut Ctx<'_, '_>, job_wd: &[u8], sep: &[u8]) -> Result<Vec<u8>, Need> {
	if job_wd == ctx.vp.cwd.as_slice() {
		return Ok(Vec::new());
	}
	let home = ctx.scalar(b"HOME")?;
	let mut note = sep.to_vec();
	note.extend_from_slice(b"(wd: ");
	note.extend_from_slice(&dirstack::polite(home.as_ref().map(|h| h.as_slice()), job_wd, false));
	note.push(b')');
	Ok(note)
}

/// `fg`: bash `start_job (job, 1)`, then wait for the job like a
/// foreground command (a stop ends the wait).
fn foreground(ctx: &mut Ctx<'_, '_>, word: Option<&BString>) -> R {
	let number = match movable(ctx, word) {
		Ok(n) => n,
		Err(st) => return done(st),
	};
	ctx.vp.jobs.set_current(number);
	let job = ctx.vp.jobs.get(number).expect("movable");
	let (text, wd, vpid) = (job.text.clone(), job.wd.clone(), job.vpid);
	let mut line = text.to_vec();
	line.extend_from_slice(&wd_note(ctx, &wd, b"\t")?);
	line.push(b'\n');
	ctx.out(&line);
	jobctl::give_terminal(ctx.k, ctx.cx, vpid);
	resume(ctx, number);
	if let Some(job) = ctx.vp.jobs.get_mut(number) {
		job.notified = true;
	}
	let wait = Wait {
		children: vec![vpid],
		all:      false,
		any:      false,
		into:     None,
		force:    false,
	};
	Ok(Outcome { status: 0, control: Control::Wait(wait) })
}

/// `bg`: bash `start_job (job, 0)`. Returns the status.
fn background(ctx: &mut Ctx<'_, '_>, word: Option<&BString>) -> i32 {
	let number = match movable(ctx, word) {
		Ok(n) => n,
		Err(st) => return st,
	};
	let job = ctx.vp.jobs.get(number).expect("movable");
	if job.state == JobState::Running {
		ctx.usage(format!("job {number} already in background"));
		return 0;
	}
	let (text, wd, vpid, os_pid) = (job.text.clone(), job.wd.clone(), job.vpid, job.os_pid);
	// POSIX: `bg` sets `$!` to the job's process group.
	ctx.vp.last_bg = LastBg::new(vpid);
	if let Some(pid) = os_pid {
		ctx.vp.last_bg.set_os(pid);
	}
	let posix = ctx.option(OptId::Posix).unwrap_or(false);
	let mark = if posix {
		" "
	} else if ctx.vp.jobs.current == Some(number) {
		"+ "
	} else if ctx.vp.jobs.previous == Some(number) {
		"- "
	} else {
		" "
	};
	let mut line = format!("[{number}]{mark}").into_bytes();
	line.extend_from_slice(&text);
	line.extend_from_slice(b" &");
	line.extend_from_slice(&wd_note(ctx, &wd, b"\t").unwrap_or_default());
	line.push(b'\n');
	ctx.out(&line);
	resume(ctx, number);
	if let Some(job) = ctx.vp.jobs.get_mut(number) {
		job.notified = true;
	}
	ctx.vp.jobs.reset_current();
	0
}

/// `disown [-h] [-ar] [jobspec … | pid …]`: drop jobs from the table, or
/// with `-h` mark them not to get a `SIGHUP`; no operand means the current
/// job (all with `-a`, the running ones with `-r`).
pub fn disown(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"ahr", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let nohup = o.has(b'h');
	let running_only = o.has(b'r');
	if o.rest.is_empty() && (o.has(b'a') || running_only) {
		let picked: Vec<u32> = ctx
			.vp
			.jobs
			.iter()
			.filter(|j| !running_only || j.state == JobState::Running)
			.map(|j| j.number)
			.collect();
		for number in picked {
			drop_job(ctx, number, nohup);
		}
		return done(0);
	}
	let mut status = 0;
	let words: Vec<Option<&BString>> = if o.rest.is_empty() {
		vec![None]
	} else {
		o.rest.iter().map(Some).collect()
	};
	for word in words {
		let found = match word {
			Some(w) if number(w).is_some_and(|n| i32::try_from(n).is_ok()) => {
				let pid = number(w).and_then(|n| u32::try_from(n).ok());
				pid.and_then(|p| ctx.vp.jobs.by_pid(p))
					.map(|j| j.number)
					.ok_or(Bad::Missing)
			},
			Some(w) => spec(ctx, w),
			None => ctx
				.vp
				.jobs
				.current
				.filter(|&n| ctx.vp.jobs.get(n).is_some())
				.ok_or(Bad::Missing),
		};
		if let Ok(number) = found {
			drop_job(ctx, number, nohup);
		} else {
			no_such_job(ctx, word.map_or(&b"current"[..], |w| w.as_slice()));
			status = 1;
		}
	}
	done(status)
}

/// `disown`'s effect on one job: `nohup` marks it, else it is deleted
/// (bash warns when that drops a stopped job), but not while no job may be
/// deleted (bash `delete_job` returns at once, `jobs.c:1492`).
fn drop_job(ctx: &mut Ctx<'_, '_>, number: u32, nohup: bool) {
	if nohup {
		if let Some(job) = ctx.vp.jobs.get_mut(number) {
			job.nohup = true;
		}
		return;
	}
	if ctx.vp.jobs_kept() {
		return;
	}
	if let Some(job) = ctx.vp.jobs.remove(number)
		&& matches!(job.state, JobState::Stopped(_))
		&& !ctx.vp.jobs.subshell
	{
		ctx.diag(Diag::Warning {
			msg: format!("warning: deleting stopped job {number} with process group {}", job.pid())
				.into(),
		});
	}
}

/// `suspend [-f]`: stop this shell until it gets `SIGCONT` (a virtual
/// `STOP` of its vproc, as bash's `killpg (shell_pgrp, SIGSTOP)`); jobs in
/// the background keep running. Without job control, or in a login shell,
/// only `-f` does it.
pub fn suspend(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"f", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	if !o.rest.is_empty() {
		// bash `no_args`: the rest of the line is abandoned.
		ctx.usage("too many arguments");
		return Ok(Outcome { status: 2, control: Control::DiscardAll });
	}
	if !o.has(b'f') {
		if !active(ctx)? {
			ctx.usage("cannot suspend: no job control");
			return done(1);
		}
		if ctx.option(OptId::LoginShell)? {
			ctx.usage("cannot suspend a login shell");
			return done(1);
		}
	}
	let vpid = ctx.vp.vpid;
	ControlHandle(ctx.k.ctl.clone()).signal(SigTarget::Vpid(vpid), Signal::Stop);
	done(0)
}
