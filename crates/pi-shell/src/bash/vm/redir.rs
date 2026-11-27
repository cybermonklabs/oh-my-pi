//! Redirections: expand each target, open through the pollable `Fs`, and
//! install the fd, saving the previous one in the op's scratch so the
//! caller can restore it.
//!
//! Progress (`done`, the expanded target, a pending `open`) lives in the
//! scratch, so a redirection list that parks resumes where it stopped.
//!
//! zsh units take [`zsh_install`]: zsh's `multios` (an fd redirected more
//! than once in one command writes to all its targets, or reads them in
//! turn; a pipeline stage's pipe counts), `noclobber` with `clobberempty`
//! and `appendcreate`, `>&p`/`<&p` coprocess fds, `{var}` checks and zsh's
//! messages. Ported from zsh 5.9 `exec.c` (`addfd`, `closemn`, `clobber_open`
//! and `execcmd`'s redirection loop; MIT-style licence, Copyright (c)
//! 1992-1997 Paul Falstad and the zsh development group).

use std::{
	fmt::NumBuffer,
	sync::Arc,
	task::{Context, Poll, Wake, Waker},
};

use bstr::{BStr, BString, ByteSlice};

use super::{
	Cx, Kernel, TextKind,
	builtins::{self, Lhs},
	exec::{Flow, expanding},
	expand::arith_value,
	probe::{absolute, dev_fd},
	proc::{
		AssignValue, BangStage, DeferPhase, Deferral, FrameKind, Probe, ProbeResult, Saved, Scratch,
		Slot, Stage, VarFd, Vproc,
	},
	state::{self, Level},
};
use crate::bash::{
	diag::Diag,
	event::{EventData, RedirInfo, RedirKind, WaitKey},
	fd::{FdOrigin, FdRef},
	fs::{File, FileKind, FsOp, FsPoll, Mark, OpenFlags, SeekFrom, StatKind},
	host::{ChildRedir, OsHandle},
	ids::Dialect,
	image::{Image, ImageDiff},
	ir::{RedirFdIr, RedirIr, RedirTargetIr, SpawnKind, Unit},
	mem::MemBuf,
	store::{KeyBuf, OptId, Record, VarValue},
	zshopt::ZshOpt,
};

/// Why a redirection list stopped.
pub enum Halt {
	/// The op parks, calls or is abandoned.
	Flow(Flow),
	/// A redirection failed (the diagnostic is printed): the command does
	/// not run and its status is 1.
	Failed,
}

fn scratch(vp: &mut Vproc) -> &mut super::proc::Scratch {
	super::exec::scratch(vp)
}

/// The top frame's I/O progress (created on first use: a redirection is
/// being applied).
fn io(vp: &mut Vproc) -> &mut super::proc::ScratchIo {
	scratch(vp).io()
}

/// Who makes a redirection list, as bash's `RX_UNDOABLE` sees it: the
/// shell saves what a redirection it will undo replaces, and a move
/// (`<&N-`) saves its source too, which fails first when the source is not
/// open (`redirection error: cannot duplicate fd`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Owner {
	/// A simple command's: undone unless bash forks for it first (an
	/// external; the command an async job or a pipeline stage was forked
	/// for; a null command that redirects fd 0 or a `{var}`), which
	/// [`undone`] works out only when a move fails.
	Simple {
		/// The command has no words and bash forks it ([`null_forks`]).
		null_forks: bool,
	},
	/// A compound command's (`{ …; } <&7-`, a loop's): `undo` is false for
	/// a subshell's own and for the command a fork was made for.
	Compound {
		/// Made in the shell and undone after the command.
		undo: bool,
		/// A bash `( … )`'s own, which bash makes in the subshell's fork:
		/// the shell keeps none of their `{var}`s ([`forgets_vars`]).
		fork: bool,
	},
}

/// [`apply`] for redirections bash applies in a child after its fork: a
/// subshell's own, and those of a simple command bash forks for first (an
/// external, a name not found, `command X`, a null command that
/// [`null_forks`]). Their words expand in that child ([`enter_child`]): its
/// assignments, arithmetic side effects, `$BASHPID` and `$RANDOM` (drawn
/// from the child's generator, a fork's copy: [`Kernel::fork_clock`]) are
/// the child's, a later word sees what an earlier one wrote, and a lookup
/// of `RANDOM` or `SECONDS` leaves the shell's value cell alone
/// ([`Kernel::redirs_in_child`]). A `${ }` or `${| }` the words hold runs
/// in the shell, reading what the child wrote before it ([`child_vars`]); it
/// starts, as do the fd install, the `{var}` the shell keeps, the subshell's
/// own-var save and the pending-break accounting that follow each word,
/// with the shell's own state ([`Vproc::vpid`], the deferral and bang paths
/// too). The shell's state is back before it returns, parked or not. zsh
/// code: [`apply`].
pub fn apply_in_child(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	list: u32,
	line: u32,
	owner: Owner,
) -> Result<(), Halt> {
	if unit.mode.dialect() != Dialect::Bash {
		return apply(k, vp, cx, unit, list, line, owner);
	}
	let shell_redirs_in_child = std::mem::replace(&mut k.redirs_in_child, true);
	let res = apply(k, vp, cx, unit, list, line, owner);
	k.redirs_in_child = shell_redirs_in_child;
	res
}

/// The child bash forks for a command's redirections, as one command's
/// words and their expansion passes share it ([`ScratchIo::child`]): what
/// the child wrote, laid over the shell's state as it is at each pass, and
/// the child's generator and clock. Over the shell's current state, not a
/// copy kept from the first pass: what the shell's own side wrote between
/// passes (a `{var}` the install assigned, a `${ }` body) still shows.
///
/// [`ScratchIo::child`]: super::proc::ScratchIo::child
pub struct ChildState {
	writes: ChildWrites,
	/// The child's `$RANDOM` generator and `$SECONDS` clock.
	clock:  super::proc::Clock,
}

/// What a command's child wrote, where its vproc keeps its state.
enum ChildWrites {
	/// The root vproc's: each store record (`None`: removed), as
	/// [`state::Root::end_child`] returns them.
	Root(Vec<(KeyBuf, Option<Record>)>),
	/// A forked vproc's: its image's changes, the locals it set (scope
	/// index, name, value), and whether it assigned a locale variable
	/// ([`Vproc::locale_gen`] `None`).
	Forked {
		image:      ImageDiff,
		locals:     Vec<(usize, BString, Option<state::Var>)>,
		locale_set: bool,
	},
}

impl Default for ChildWrites {
	fn default() -> Self {
		Self::Root(Vec::new())
	}
}

/// The shell's own state, set aside while an expansion pass of a word of
/// redirections bash makes in a child runs on the child's state
/// ([`enter_child`]); [`leave_child`] puts it back and keeps what the pass
/// wrote.
pub struct ShellState {
	clock:  Option<super::proc::Clock>,
	pid:    Option<crate::bash::ids::Vpid>,
	/// A forked vproc's image, locale count and scope maps as they were
	/// (the root vproc's records are put back by [`state::Root::end_child`]).
	forked: Option<(Image, Option<u64>, Vec<state::ScopeVars>)>,
	/// The command's [`ChildState`], its box kept for [`leave_child`].
	child:  Option<Box<ChildState>>,
}

/// Start an expansion pass of a word of redirections bash makes in a child
/// ([`Kernel::redirs_in_child`]) on that child's state: the shell's state
/// with the child's earlier writes ([`ChildState`], kept in `sc`, the
/// scratch of the command's op) laid over it, the child's clock, and a
/// reserved pid for `$BASHPID`. It copies nothing the pass does not write:
/// the root vproc's pass runs on the store, every record it writes put back
/// at [`leave_child`] ([`state::Root::begin_child`]); a forked vproc's
/// image and scope maps are shared with the pass, which copies one only to
/// write it.
#[cold]
#[inline(never)]
pub fn enter_child(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
) -> ShellState {
	let mut child = sc.io.as_mut().and_then(|io| io.child.take());
	let clock = child
		.as_deref()
		.map_or_else(|| k.fork_clock(vp), |c| c.clock);
	let writes = child.as_deref_mut().map(|c| std::mem::take(&mut c.writes));
	let forked = if vp.image.is_none() {
		let writes = match writes {
			Some(ChildWrites::Root(writes)) => writes,
			_ => Vec::new(),
		};
		k.root.begin_child(cx.store, writes);
		None
	} else {
		let base = vp.image.clone().unwrap_or_default();
		let vars: Vec<state::ScopeVars> = vp.scopes.iter().map(|s| s.vars.clone()).collect();
		let locale = vp.locale_gen;
		if let Some(ChildWrites::Forked { image, locals, locale_set }) = writes {
			vp.image = Some(Image::patched(base.clone(), image));
			for (i, name, var) in locals {
				if let Some(scope) = vp.scopes.get_mut(i) {
					scope.vars.insert(name, var);
				}
			}
			if locale_set {
				vp.locale_gen = None;
			}
		}
		Some((base, locale, vars))
	};
	// The vpid bash's fork would take, peeked without consuming one: a word
	// that reads `$BASHPID` needs a value distinct from the shell, and a
	// command with no vpid left still fails to fork as bash's does. Peeked
	// again at each pass: a `$( )` an earlier pass started took the one
	// peeked then.
	let child_vpid = crate::bash::ids::Vpid(k.next_vpid);
	ShellState {
		clock: vp.clock.replace(clock),
		pid: k.redirs_child_pid.replace(child_vpid),
		forked,
		child,
	}
}

/// End the pass [`enter_child`] started: the shell's state is back, and
/// what the pass's child wrote is kept in `sc` for the command's next word
/// or pass (dropped with the op's scratch).
#[cold]
#[inline(never)]
pub fn leave_child(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	shell: ShellState,
) {
	let ShellState { clock, pid, forked, child } = shell;
	k.redirs_child_pid = pid;
	let child_clock = std::mem::replace(&mut vp.clock, clock);
	let writes = match forked {
		None => ChildWrites::Root(k.root.end_child(cx.store)),
		Some((base, locale, vars)) => {
			let image = vp.image.as_ref().map_or_default(|image| image.diff(&base));
			vp.image = Some(base);
			let mut locals = Vec::new();
			for (i, shell_vars) in vars.into_iter().enumerate() {
				let Some(scope) = vp.scopes.get_mut(i) else {
					continue;
				};
				if scope.vars.same(&shell_vars) {
					continue;
				}
				for (name, var) in &scope.vars {
					if shell_vars.get(name) != Some(var) {
						locals.push((i, name.clone(), var.clone()));
					}
				}
				scope.vars = shell_vars;
			}
			let locale_set = vp.locale_gen.is_none();
			vp.locale_gen = locale;
			ChildWrites::Forked { image, locals, locale_set }
		},
	};
	let Some(child_clock) = child_clock else {
		return;
	};
	let mut child = child.unwrap_or_else(|| {
		Box::new(ChildState { writes: ChildWrites::default(), clock: child_clock })
	});
	child.writes = writes;
	child.clock = child_clock;
	sc.io().child = Some(child);
}

/// The variables the child of the command whose op scratch is `sc` wrote
/// in its words so far, with their values (`None`: unset), into `out`: a
/// `${ }` or `${| }` there, which bash runs in that child, reads them
/// ([`super::exec::start_sub`]). A local the child wrote hides a global of
/// its name.
pub fn child_vars(sc: &Scratch, out: &mut state::VarMap) {
	let Some(child) = sc.io.as_ref().and_then(|io| io.child.as_deref()) else {
		return;
	};
	let var = |rec: Option<&Record>| match rec {
		Some(Record::Var(v)) => Some(v.clone()),
		_ => None,
	};
	match &child.writes {
		ChildWrites::Root(writes) => {
			for (key, rec) in writes {
				if let KeyBuf::Var(name) = key {
					out.insert(name.clone(), var(rec.as_ref()));
				}
			}
			for (key, rec) in writes {
				if let KeyBuf::Local { name, .. } = key {
					out.insert(name.clone(), var(rec.as_ref()));
				}
			}
		},
		ChildWrites::Forked { image, locals, .. } => {
			for (name, rec) in image.vars() {
				out.insert(name.clone(), var(rec));
			}
			for (_, name, value) in locals {
				out.insert(name.clone(), value.clone());
			}
		},
	}
}

/// Apply redirection list `list` of `unit` for `owner`.
pub fn apply(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	list: u32,
	line: u32,
	owner: Owner,
) -> Result<(), Halt> {
	let redirs = &unit.redirs[list as usize];
	let zsh = unit.mode.dialect() == Dialect::Zsh;
	let multios =
		zsh && state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Multios).unwrap_or(true);
	loop {
		// Read without creating the progress: an empty list needs none.
		let done = scratch(vp).io.as_ref().map_or(0, |io| io.redir.done);
		// Past the list: the zsh duplicates of a several-word target.
		let (r, copy) = if let Some(r) = redirs.get(done) {
			(r, None)
		} else {
			let more = scratch(vp)
				.io
				.as_ref()
				.and_then(|io| io.zsh.as_ref())
				.and_then(|z| z.more.get(done - redirs.len()));
			match more {
				Some((i, t)) => (&redirs[*i as usize], Some(t.clone())),
				None => return Ok(()),
			}
		};
		if multios && done == 0 && io(vp).zsh.as_ref().is_none_or(|z| z.multio.is_empty()) {
			seed_pipeline(vp, unit);
		}
		let target = if let Some(t) = io(vp).redir.target.clone().or(copy) {
			t
		} else if zsh {
			let mut words = zsh_target(k, vp, cx, unit, r, multios, line)?;
			if words.len() > 1 {
				// Several words: one redirection each, after the list.
				let at = u32::try_from(done).unwrap_or(u32::MAX);
				let progress = io(vp);
				progress
					.zsh()
					.more
					.extend(words.into_iter().map(|w| (at, w)));
				progress.redir.done += 1;
				scratch(vp).logs[Slot::Redirs as usize].clear();
				continue;
			}
			let t = words.pop().unwrap_or_default();
			io(vp).redir.target = Some(t.clone());
			t
		} else {
			let t = match target_text(k, vp, cx, unit, r, line)? {
				Ok(t) => t,
				Err(d) if collecting(k, vp) => {
					fail_in_child(k, vp, cx, line, &d);
					end_collect(vp, redirs.len());
					return Ok(());
				},
				Err(d) => return Err(fail(k, vp, cx, line, d)),
			};
			io(vp).redir.target = Some(t.clone());
			t
		};
		let before = io(vp).saved.len();
		if zsh {
			match zsh_install(k, vp, cx, r, &target, line, multios) {
				// The open waits (a FIFO without its other end): the
				// background job this vproc decides keeps its virtual pid, so
				// a reader of `$!` never waits on that rendezvous, which may
				// need the reader. (zsh's `$!` names its forked child, which
				// opens the FIFO; a bash lone external leaves the open to its
				// process ([`defer`]), which zsh's redirections do not.)
				Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path })))
					if !k.bangs.is_empty() =>
				{
					k.settle_bang(vp.vpid, None);
					return Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path })));
				},
				res => res?,
			}
		} else if collecting(k, vp) {
			if !collect(k, vp, cx, unit, r, &target, line) {
				end_collect(vp, redirs.len());
				return Ok(());
			}
		} else {
			// A FIFO the job's process will open itself is decided before any
			// open starts: an in-flight open that is dropped wakes its helper by
			// opening the other end, which the FIFO's real peer observes (a
			// writer then sees its reader vanish).
			if !k.bangs.is_empty() && waits_on_fifo(cx, vp, r, &target) {
				let path = absolute(&vp.cwd, &target);
				if deferrable(k, vp, cx, &redirs[done..], &path) {
					start_deferral(vp, k);
					return Ok(());
				}
			}
			match install(k, vp, cx, unit, r, &target, line, owner) {
				Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path })))
					if !k.bangs.is_empty() =>
				{
					if defer(k, vp, cx, &redirs[done..], &path) {
						return Ok(());
					}
					return Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path })));
				},
				res => res?,
			}
		}
		if let RedirFdIr::Var(name) = &r.fd
			&& !state::option(&mut k.root, cx.store, vp, OptId::VarredirClose).unwrap_or(false)
			&& let Some(fd) = var_fd(k, vp, cx, name)
		{
			// A `{var}` fd outlives its command (unless `varredir_close`).
			let saved = &mut io(vp).saved;
			let mut i = before;
			while i < saved.len() {
				if saved[i].fd == fd {
					saved.remove(i);
				} else {
					i += 1;
				}
			}
		}
		let sc = scratch(vp);
		let progress = &mut sc.io().redir;
		progress.done += 1;
		progress.target = None;
		sc.logs[Slot::Redirs as usize].clear();
		if k.mask.contains(crate::bash::event::EventKind::Redirect) {
			let fd = match r.fd {
				RedirFdIr::Num(n) => n as i32,
				_ => default_fd(r.op),
			};
			let info = RedirInfo { fd, op: r.op, target: target.clone() };
			k.emit_op(cx, vp, unit.words.get(word_of(r)).map_or(0, |w| w.node), EventData::Redirect {
				redir: &info,
			});
		}
	}
}

const fn word_of(r: &RedirIr) -> usize {
	match r.target {
		RedirTargetIr::Word(w) => w as usize,
		RedirTargetIr::HereDoc { .. } => usize::MAX,
	}
}

const fn default_fd(op: RedirKind) -> i32 {
	match op {
		RedirKind::In
		| RedirKind::ReadWrite
		| RedirKind::DupIn
		| RedirKind::HereDoc
		| RedirKind::HereString => 0,
		_ => 1,
	}
}

/// Whether bash runs a null command with redirections `list` (`< f`,
/// `{v}<&7`) in a fork of its own (`execute_null_command`'s `forcefork`): a
/// redirection of fd 0 or of a `{var}`.
pub(super) fn null_forks(list: &[RedirIr]) -> bool {
	list.iter().any(|r| match r.fd {
		RedirFdIr::Var(_) => true,
		RedirFdIr::Num(n) => n == 0,
		RedirFdIr::Default => default_fd(r.op) == 0,
	})
}

/// The text bash stores for word `w`, which `ambiguous redirect` names:
/// the source, with each command substitution as the parser re-prints it
/// (`$(  true;false  )` is `$(true; false)`, `${| return 3; }` is
/// `${|return 3; }`), `$'…'` decoded in single quotes and `$"…"` as `"…"`
/// ([`crate::bash::syntax::word_text`]). The unit's syntax is parsed again
/// for it (an error path); a zsh word, or one that syntax does not hold at
/// the word's span, is named by its source text.
fn word_text(unit: &Unit, w: u32) -> BString {
	let node = unit.words[w as usize].node;
	let Some(info) = unit.nodes.get(node as usize) else {
		return BString::default();
	};
	let source = || {
		BString::from(
			unit
				.source
				.get(info.lo as usize..info.hi as usize)
				.unwrap_or_default(),
		)
	};
	if unit.mode.dialect() != Dialect::Bash {
		return source();
	}
	let syntax = match unit.trace_syntax.get() {
		Some(s) => Arc::clone(s),
		None => match crate::bash::trace::syntax::UnitSyntax::restore(unit) {
			Some(s) => Arc::new(s),
			None => return source(),
		},
	};
	let tree = &syntax.tree.tree;
	// The word is the node of its preorder id ([`crate::bash::syntax::NodeId`])
	// at its span: unit-relative (a re-parsed unit) or from the offset the
	// syntax keeps (a deferred function body).
	let at = tree.nodes.iter().position(|n| {
		n.kind == crate::bash::syntax::tree::K::Word
			&& n.id == node
			&& ((n.lo, n.hi) == (info.lo, info.hi)
				|| (n.lo.checked_sub(syntax.offset), n.hi.checked_sub(syntax.offset))
					== (Some(info.lo), Some(info.hi)))
	});
	let Some(at) = at else {
		return source();
	};
	let mut out = Vec::new();
	crate::bash::syntax::word_text(crate::bash::syntax::Word::at(tree, at as u32), &mut out);
	BString::from(out)
}

/// The expanded target (a path, an fd number, or document bytes). `Ok(Err(d))`:
/// a file or dup word that expands to no field or several (`$word:
/// ambiguous redirect`), which fails the redirection (the caller prints `d`,
/// or leaves it to the process that applies the redirection, [`collect`]).
fn target_text(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	r: &RedirIr,
	line: u32,
) -> Result<Result<BString, Diag>, Halt> {
	match &r.target {
		RedirTargetIr::HereDoc { text, quoted: true } => Ok(Ok(text.clone())),
		RedirTargetIr::HereDoc { text, quoted: false } if unit.mode.dialect() == Dialect::Zsh => {
			expanding(k, vp, cx, Slot::Redirs, true, line, |ex| ex.zsh_heredoc(text))
				.map(Ok)
				.map_err(Halt::Flow)
		},
		RedirTargetIr::HereDoc { text, quoted: false } => {
			let mode = super::exec::mode_of(vp);
			let tunit = match k.engine.text_unit(
				text,
				TextKind::HereDoc,
				mode,
				k.mask.contains(crate::bash::event::EventKind::UnitCompiled),
			) {
				Ok(u) => u,
				Err(e) => {
					// bash reports the script line after the document.
					#[expect(
						clippy::naive_bytecount,
						reason = "one here-document per redirection; no bytecount dependency"
					)]
					let at = line + text.iter().filter(|&&c| c == b'\n').count() as u32 + 1;
					k.diag(cx, vp, line, Diag::ComsubSyntax { line: at, msg: e.msg });
					return Err(Halt::Failed);
				},
			};
			let w = tunit.words.last().cloned().unwrap_or_default();
			expanding(k, vp, cx, Slot::Redirs, true, line, |ex| ex.scalar(&tunit, &w))
				.map(Ok)
				.map_err(Halt::Flow)
		},
		RedirTargetIr::Word(w) => {
			let word = &unit.words[*w as usize];
			if r.op == RedirKind::HereString {
				let mut s =
					expanding(k, vp, cx, Slot::Redirs, word.parks, line, |ex| ex.scalar(unit, word))
						.map_err(Halt::Flow)?;
				s.push(b'\n');
				Ok(Ok(s))
			} else {
				// Files and dup targets: no field or several is
				// `$word: ambiguous redirect` with the source text. Outside
				// posix mode the word is pathname-expanded too (a park
				// replays the expansion; the walk's answers are cached).
				let glob = !state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
				let (mut fields, globs) = expanding(k, vp, cx, Slot::Redirs, word.parks, line, |ex| {
					let mut out = Vec::new();
					let mut globs = Vec::new();
					if glob {
						ex.fields_glob(unit, word, &mut out, &mut globs)?;
					} else {
						ex.fields(unit, word, &mut out)?;
					}
					Ok((out, globs))
				})
				.map_err(Halt::Flow)?;
				if !globs.is_empty() {
					super::glob::expand_globs(k, vp, cx, &mut fields, &globs, line)
						.map_err(Halt::Flow)?;
				}
				Ok(<[BString; 1]>::try_from(fields)
					.map(|[one]| one)
					.map_err(|_| Diag::AmbiguousRedirect { word: word_text(unit, *w) }))
			}
		},
	}
}

/// zsh `xpandredir`: the words the target of zsh redirection `r` names.
/// With `multios` the word takes the full expansion and filename
/// generation (several words make one redirection each; none is the empty
/// name; `<&` needs exactly one: `file number expected`); without it the
/// word expands to one string (`PREFORK_SINGLE`), not globbed.
/// Here-documents and here-strings are [`target_text`]'s.
#[inline(never)]
fn zsh_target(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	r: &RedirIr,
	multios: bool,
	line: u32,
) -> Result<Vec<BString>, Halt> {
	let RedirTargetIr::Word(w) = r.target else {
		return document(k, vp, cx, unit, r, line);
	};
	if r.op == RedirKind::HereString {
		return document(k, vp, cx, unit, r, line);
	}
	let word = &unit.words[w as usize];
	if !multios {
		return expanding(k, vp, cx, Slot::Redirs, word.parks, line, |ex| ex.scalar(unit, word))
			.map(|t| vec![t])
			.map_err(Halt::Flow);
	}
	let (mut fields, globs) = expanding(k, vp, cx, Slot::Redirs, word.parks, line, |ex| {
		let mut out = Vec::new();
		let mut globs = Vec::new();
		ex.fields_glob(unit, word, &mut out, &mut globs)?;
		Ok((out, globs))
	})
	.map_err(Halt::Flow)?;
	if !globs.is_empty() {
		super::zsh::zglob::expand_globs(k, vp, cx, &mut fields, &globs, line).map_err(Halt::Flow)?;
	}
	if r.op == RedirKind::DupIn && fields.len() != 1 {
		return Err(fail(k, vp, cx, line, zsh_msg("file number expected".into())));
	}
	Ok(fields)
}

/// The one word of a here-document or here-string ([`target_text`], which
/// finds no ambiguity in a document).
fn document(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	r: &RedirIr,
	line: u32,
) -> Result<Vec<BString>, Halt> {
	match target_text(k, vp, cx, unit, r, line)? {
		Ok(t) => Ok(vec![t]),
		Err(d) => Err(fail(k, vp, cx, line, d)),
	}
}

/// Set fd `fd` to `h` (or close it), saving the previous object.
fn set_fd(vp: &mut Vproc, fd: i32, h: Option<FdRef>) {
	let prev = vp.fds.get(fd).cloned();
	io(vp).saved.push(Saved { fd, prev });
	vp.fds.set(fd, h);
}

/// The fd a redirection targets; `{var}` allocates one ≥ 10 and stores it
/// (`closing`: reads the fd it holds; `record`: [`assign_fd_var`]'s).
fn target_fd(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	closing: bool,
	record: bool,
	line: u32,
) -> Result<i32, Halt> {
	match &r.fd {
		RedirFdIr::Default => Ok(default_fd(r.op)),
		RedirFdIr::Num(n) => Ok(*n as i32),
		RedirFdIr::Var(name) => {
			if closing {
				return var_fd(k, vp, cx, name).ok_or_else(|| {
					fail(k, vp, cx, line, Diag::AmbiguousRedirect { word: name.clone() })
				});
			}
			let fd = super::jobctl::lowest_free_fd(k, vp, 10);
			assign_fd_var(k, vp, cx, name, fd, record, line)?;
			Ok(fd)
		},
	}
}

/// Store `fd` in the `{var}` named `name`. With `record` (bash makes the
/// redirection in a fork, [`forgets_vars`]) the variable's binding before
/// is noted for the shell to put back: a simple command's in
/// [`super::proc::ExecState::var_fds`], a `( … )`'s `Redir` op's in
/// [`super::proc::ScratchIo::var_fds`].
fn assign_fd_var(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	name: &[u8],
	fd: i32,
	record: bool,
	line: u32,
) -> Result<(), Halt> {
	let before = if record {
		var_before(k, vp, cx, name)
	} else {
		None
	};
	let (base, index) = builtins::split_subscript(name);
	let lhs = Lhs { name: base, index, append: false };
	let value = AssignValue::Scalar(BString::from(fd.to_string()));
	if let Err(d) = builtins::set_value(k, cx, vp, lhs, value, Level::Dynamic) {
		// An arithmetic subscript error is bash's `array_expand_index`:
		// `top_level_cleanup`, then `jump_to_top_level (DISCARD)`, before
		// the redirection reports anything of its own. Where bash makes the
		// redirection in a fork of its own (`record`: an external's, a
		// `( … )`'s), that DISCARD ends only the fork, with status 1: the
		// command fails and the line goes on.
		if super::exec::cleanup_jump(vp, &d) {
			k.diag(cx, vp, line, d);
			if record {
				return Err(Halt::Failed);
			}
			let flow = Flow::DiscardTop(1);
			super::exec::jump_out(k, cx, vp, true, &flow);
			return Err(Halt::Flow(flow));
		}
		// bash: the assignment's error, then this one. `sh_invalidid` is a
		// builtin error, named by the simple command's word if it has one
		// (`exec: `10': not a valid identifier`).
		let cmd = super::exec::scratch(vp)
			.exec
			.as_ref()
			.and_then(|e| e.argv.first())
			.map(|w| w.to_str_lossy().into_owned());
		let d = match (d, cmd) {
			(d @ Diag::InvalidIdent { .. }, Some(cmd)) => d.by(cmd),
			(d, _) => d,
		};
		k.diag(cx, vp, line, d);
		let msg = format!("{}: cannot assign fd to variable", name.as_bstr()).into();
		return Err(fail(k, vp, cx, line, Diag::Usage { msg }));
	}
	if let Some(var) = before {
		let var = VarFd { fd, ..var };
		match super::exec::scratch(vp).exec.as_mut() {
			Some(e) => e.var_fds.get_or_insert_with(Box::default).push(var),
			None => io(vp).var_fds.get_or_insert_with(Box::default).push(var),
		}
	}
	Ok(())
}

/// The variable a `{var}` named `name` assigns (through namerefs; the
/// whole array for an element) and its declared binding now (`None`:
/// unbound), as a [`VarFd`] whose fd is still to be set; `None` for a
/// circular reference or a positional parameter.
fn var_before(k: &Kernel, vp: &Vproc, cx: &mut Cx<'_>, name: &[u8]) -> Option<VarFd> {
	let (base, _) = builtins::split_subscript(name);
	let base: BString = match state::deref(&k.root, cx.store, vp, base).ok()? {
		state::Deref::Plain => base.into(),
		state::Deref::To { name, .. } => name,
		state::Deref::Circular => return None,
	};
	if base.is_empty() || base.iter().all(u8::is_ascii_digit) {
		return None;
	}
	let prior = state::lookup_declared(&k.root, cx.store, vp, &base)
		.ok()?
		.cloned();
	Some(VarFd { fd: -1, name: base, prior })
}

/// Whether bash makes the redirections `owner` makes in a fork of its own,
/// so that the shell keeps none of their `{var}`s: a simple command bash
/// forks for before its redirections (an external, a name not found,
/// `command X`, a null command that [`null_forks`]), a bash `( … )`'s own.
/// Only theirs are recorded ([`assign_fd_var`]).
fn forgets_vars(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, owner: Owner) -> bool {
	match owner {
		Owner::Compound { fork, .. } => fork,
		Owner::Simple { null_forks } => null_forks || super::command::forks_for(k, cx, vp),
	}
}

/// Undo the `{var}` redirections made so far that bash made in a fork
/// ([`forgets_vars`]), when they fail or the command ends: neither the fd
/// nor the variable reaches the shell.
pub(super) fn forget_var_fds(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let vars = match super::exec::scratch(vp).exec.as_mut() {
		Some(e) => e.var_fds.take(),
		None => io(vp).var_fds.take(),
	};
	if let Some(vars) = vars {
		forget_vars(k, vp, cx, *vars);
	}
}

/// Close each `{var}` fd of `vars` and give each variable its binding
/// back, latest first.
pub(super) fn forget_vars(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, vars: Vec<VarFd>) {
	for VarFd { fd, name, prior } in vars.into_iter().rev() {
		vp.fds.set(fd, None);
		state::store_var(&mut k.root, cx.store, vp, &name, prior, Level::Dynamic);
	}
}

/// The fd number a `{var}` holds, if it holds one (through namerefs).
fn var_fd(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, name: &[u8]) -> Option<i32> {
	let (base, index) = builtins::split_subscript(name);
	let (base, index): (BString, Option<BString>) =
		match state::deref(&k.root, cx.store, vp, base).ok()? {
			state::Deref::Plain => (base.into(), index.map(BString::from)),
			state::Deref::To { name, index: to } => (name, to.or_else(|| index.map(BString::from))),
			state::Deref::Circular => return None,
		};
	let index = index.as_deref().map(|i| i.as_slice());
	// zsh `{1}>&-`: a positional parameter (a `zle -F` handler closing the
	// fd it was given).
	if index.is_none() && !base.is_empty() && base.iter().all(u8::is_ascii_digit) {
		let n: usize = std::str::from_utf8(&base).ok()?.parse().ok()?;
		let args = state::positional_ref(&k.root, cx.store, vp).ok()?;
		let text = args.get(n.checked_sub(1)?)?;
		return std::str::from_utf8(text).ok()?.trim().parse().ok();
	}
	let var = state::lookup(&k.root, cx.store, vp, &base)
		.ok()
		.flatten()?
		.clone();
	let text = match index {
		None => BString::from(var.as_scalar()?),
		Some(key) if matches!(var.value, VarValue::Assoc(_)) => BString::from(var.key(key)?),
		Some(sub) => {
			let i = arith_value(k, cx, vp, sub).ok()?;
			BString::from(var.index(i)?)
		},
	};
	std::str::from_utf8(&text).ok()?.trim().parse().ok()
}

#[expect(clippy::too_many_arguments, reason = "the redirection's context, as `apply` has it")]
fn install(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	r: &RedirIr,
	target: &BString,
	line: u32,
	owner: Owner,
) -> Result<(), Halt> {
	// A `{var}` bash makes in a fork is recorded, for the shell to forget.
	let record = matches!(r.fd, RedirFdIr::Var(_)) && forgets_vars(k, cx, vp, owner);
	match r.op {
		RedirKind::HereDoc | RedirKind::HereString => {
			let fd = target_fd(k, vp, cx, r, false, record, line)?;
			let h = FdRef::mem(MemBuf::new(target.to_vec()));
			set_fd(vp, fd, Some(h));
			Ok(())
		},
		RedirKind::DupIn | RedirKind::DupOut => {
			let closing = target.as_slice() == b"-";
			if closing {
				let fd = target_fd(k, vp, cx, r, true, false, line)?;
				set_fd(vp, fd, None);
				super::exec::coproc_fd_closed(k, vp, cx, fd);
				return Ok(());
			}
			let (digits, moving) = match target.strip_suffix(b"-") {
				Some(d) => (d, true),
				None => (target.as_slice(), false),
			};
			// An empty word is all digits (bash's `all_digits("")`): a source
			// that is no fd.
			if digits.iter().all(u8::is_ascii_digit) {
				let src: i32 = std::str::from_utf8(digits)
					.ok()
					.and_then(|s| s.parse().ok())
					.unwrap_or(-1);
				let Some(h) = vp.fds.get(src).cloned().filter(FdRef::is_open) else {
					// Saving the source first fails first: a `{var}` copy
					// (`F_DUPFD`), or a move the shell undoes whose target
					// is open (`add_undo_redirect`).
					let var = matches!(r.fd, RedirFdIr::Var(_));
					if var
						|| (moving
							&& dup_fd(r).is_some_and(|fd| vp.fds.get(fd).is_some_and(FdRef::is_open))
							&& undone(k, cx, vp, owner))
					{
						k.diag(cx, vp, line, Diag::CannotDuplicateFd);
					}
					let path = dup_name(unit, r, src, target);
					let err = std::io::Error::other(crate::bash::fd::BadFd);
					return Err(fail(k, vp, cx, line, Diag::Io { path, err }));
				};
				let fd = target_fd(k, vp, cx, r, false, record, line)?;
				set_fd(vp, fd, Some(h));
				if moving && src != fd {
					set_fd(vp, src, None);
					super::exec::coproc_fd_closed(k, vp, cx, src);
				}
				return Ok(());
			}
			if r.op == RedirKind::DupOut && matches!(r.fd, RedirFdIr::Default) {
				// `>&file` is `&>file`.
				return open_into(
					k,
					vp,
					cx,
					&[1, 2],
					target,
					OpenFlags::WRITE
						.with(OpenFlags::CREATE)
						.with(OpenFlags::TRUNC),
					line,
				);
			}
			Err(fail(k, vp, cx, line, Diag::AmbiguousRedirect { word: target.clone() }))
		},
		RedirKind::Close => {
			let fd = target_fd(k, vp, cx, r, true, false, line)?;
			set_fd(vp, fd, None);
			super::exec::coproc_fd_closed(k, vp, cx, fd);
			Ok(())
		},
		RedirKind::OutErr | RedirKind::AppendErr => {
			let flags = open_flags(k, vp, cx, r.op, target);
			open_into(k, vp, cx, &[1, 2], target, flags, line)
		},
		RedirKind::In
		| RedirKind::Out
		| RedirKind::Append
		| RedirKind::Clobber
		| RedirKind::ReadWrite => {
			let flags = open_flags(k, vp, cx, r.op, target);
			// bash opens the file first and assigns `{var}` after (a
			// readonly one leaves the file created); a parked open keeps
			// its slot free, so the fd is the same on resume.
			let fd = match &r.fd {
				RedirFdIr::Var(_) => super::jobctl::lowest_free_fd(k, vp, 10),
				_ => target_fd(k, vp, cx, r, false, false, line)?,
			};
			// bash moves a `{var}` fd to 10 or above with `F_DUPFD`, which
			// fails past `ulimit -n`.
			let limit = vp
				.rlimits()
				.iter()
				.find(|(res, ..)| *res == crate::bash::host::Rlimit::Nofile)
				.and_then(|&(_, soft, _)| soft);
			if matches!(r.fd, RedirFdIr::Var(_))
				&& limit.is_some_and(|lim| u64::try_from(fd).is_ok_and(|fd| fd >= lim))
			{
				let mut msg = k.argv0.to_vec();
				msg.extend_from_slice(b": redirection error: cannot duplicate fd: Invalid argument\n");
				vp.out
					.push_back(super::proc::PendingWrite::new(2, msg.into()));
				let err = std::io::Error::from(std::io::ErrorKind::InvalidInput);
				return Err(fail(k, vp, cx, line, Diag::Io { path: target.clone(), err }));
			}
			open_into(k, vp, cx, &[fd], target, flags, line)?;
			if let RedirFdIr::Var(name) = &r.fd
				&& let Err(halt) = assign_fd_var(k, vp, cx, name, fd, record, line)
			{
				set_fd(vp, fd, None);
				return Err(halt);
			}
			Ok(())
		},
	}
}

/// The fd duplication `r` (`<&`, `>&`) sets when it names one: its
/// number, or the operator's (0 for `<&`, 1 for `>&`); `None` for
/// `{var}`, whose fd is chosen when it opens.
fn dup_fd(r: &RedirIr) -> Option<i32> {
	match r.fd {
		RedirFdIr::Num(n) => i32::try_from(n).ok(),
		RedirFdIr::Default => Some(i32::from(r.op != RedirKind::DupIn)),
		RedirFdIr::Var(_) => None,
	}
}

/// The name bash's `redirection_error` gives a duplication whose source
/// `src` is not open (redir.c): a source written as a number (`<&7`,
/// `<&07`, `<&7-`) by its value; a word (`<&$fd`, `<&"7"`) that copies
/// onto the operator's own fd (`<&` 0, `>&` 1) as written; any other word
/// (`3<&$fd`, a move `<&$fd-`) by the fd it sets.
fn dup_name(unit: &Unit, r: &RedirIr, src: i32, target: &BString) -> BString {
	let RedirTargetIr::Word(w) = r.target else {
		return target.clone();
	};
	let written = word_text(unit, w);
	let (digits, moving) = match written.strip_suffix(b"-") {
		Some(d) => (d, true),
		None => (written.as_slice(), false),
	};
	if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) {
		return BString::from(src.format_into(&mut NumBuffer::new()));
	}
	let own = i32::from(r.op != RedirKind::DupIn);
	match dup_fd(r) {
		Some(fd) if moving || fd != own => BString::from(fd.format_into(&mut NumBuffer::new())),
		_ => written,
	}
}

/// Whether the shell undoes the redirections `owner` makes (bash's
/// `RX_UNDOABLE`): a compound's as [`apply`]'s caller says; a simple
/// command's unless bash forks for it before them (the command a fork was
/// made for, an external, a null command that [`null_forks`]).
fn undone(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, owner: Owner) -> bool {
	match owner {
		Owner::Compound { undo, .. } => undo,
		Owner::Simple { null_forks } => {
			let forked = vp.frames.len() == 1 && vp.fork().at_entry();
			!forked && !null_forks && !super::command::forks_for(k, cx, vp)
		},
	}
}

/// How a file redirection `op` to `target` opens it (`set -o noclobber`
/// makes `>` exclusive, but for `/dev/…`).
fn open_flags(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	op: RedirKind,
	target: &BString,
) -> OpenFlags {
	let noclobber = op == RedirKind::Out
		&& !target.starts_with(b"/dev/")
		&& state::option(&mut k.root, cx.store, vp, OptId::Noclobber).unwrap_or(false);
	let write = OpenFlags::WRITE.with(OpenFlags::CREATE);
	match op {
		_ if noclobber => write.with(OpenFlags::EXCL),
		RedirKind::In => OpenFlags::READ,
		RedirKind::Out | RedirKind::Clobber => write.with(OpenFlags::TRUNC),
		RedirKind::Append | RedirKind::AppendErr => write.with(OpenFlags::APPEND),
		RedirKind::OutErr => write.with(OpenFlags::TRUNC),
		_ => write.with(OpenFlags::READ),
	}
}

/// Whether the process a command spawns can apply redirection `r` itself
/// ([`collect`]): a file open, a numeric duplication or a close of a
/// numbered fd (not a here-document, not a `{var}` fd).
const fn childable(r: &RedirIr) -> bool {
	!matches!(r.fd, RedirFdIr::Var(_))
		&& matches!(r.target, RedirTargetIr::Word(_))
		&& matches!(
			r.op,
			RedirKind::In
				| RedirKind::Out
				| RedirKind::Append
				| RedirKind::Clobber
				| RedirKind::ReadWrite
				| RedirKind::OutErr
				| RedirKind::AppendErr
				| RedirKind::DupIn
				| RedirKind::DupOut
				| RedirKind::Close
		)
}

/// The open of `path` for the first of the redirections `rest` would wait
/// (a FIFO without its other end) in a vproc deciding a background job's
/// pid ([`super::proc::Bang`]): `$!` readers must not wait on that
/// rendezvous, which may need them. A job's lone command may leave the
/// open and the redirections after it to the process it spawns, once its
/// name resolves to an external ([`super::proc::Deferral`]): the stage
/// stops here (`true`; the pending open is dropped, the process repeats
/// it). Otherwise the job keeps its virtual pid and the open waits here
/// (`false`).
fn defer(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	rest: &[RedirIr],
	path: &BString,
) -> bool {
	if !deferrable(k, vp, cx, rest, path) {
		k.settle_bang(vp.vpid, None);
		return false;
	}
	// The pending open is dropped here; the process repeats it.
	io(vp).redir.opening = None;
	start_deferral(vp, k);
	true
}

/// Whether redirection `r` to `target` opens a FIFO for one direction only,
/// the open that waits for the other end (`O_RDWR` never does). A stat the
/// filesystem cannot answer at once counts as no.
fn waits_on_fifo(cx: &mut Cx<'_>, vp: &Vproc, r: &RedirIr, target: &BString) -> bool {
	let one_way = matches!(
		r.op,
		RedirKind::In
			| RedirKind::Out
			| RedirKind::Append
			| RedirKind::Clobber
			| RedirKind::OutErr
			| RedirKind::AppendErr
	);
	if !one_way || !childable(r) || dev_fd(target).is_some() {
		return false;
	}
	let path = absolute(&vp.cwd, target);
	matches!(cx.host.fs().stat(BStr::new(&path), true), FsPoll::Ready(Ok(st)) if st.kind == StatKind::Fifo)
}

/// Whether the job's lone external may leave the open of `path` and the
/// redirections after it (`rest`) to the process it spawns.
fn deferrable(k: &Kernel, vp: &Vproc, cx: &mut Cx<'_>, rest: &[RedirIr], path: &BString) -> bool {
	let Some(bang) = k.bangs.iter().find(|b| b.vproc == vp.vpid) else {
		return false;
	};
	let command = vp
		.frames
		.last()
		.and_then(|f| f.scratch.as_ref())
		.and_then(|s| s.exec.as_ref())
		.is_some_and(|e| e.stage == Stage::Redirect && !e.argv.is_empty());
	bang.stage == BangStage::Lone
		&& command
		&& !k.deferrals.iter().any(|d| d.vproc == vp.vpid)
		&& rest.iter().all(childable)
		&& cx.host.child_opens(BStr::new(path))
}

/// Hand the current redirection and those after it to the spawned process.
fn start_deferral(vp: &mut Vproc, k: &mut Kernel) {
	let from = io(vp).redir.done;
	k.deferrals
		.push(Deferral { vproc: vp.vpid, from, phase: DeferPhase::Lookup, list: Vec::new() });
}

/// What a spawned process prints before an error's description for `what`
/// (`bash: line 1: f: `), as [`Diag::Io`] renders it here.
pub fn diag_prefix(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, line: u32, what: &[u8]) -> BString {
	let err = std::io::Error::other("");
	let mut text = k.render_quiet(cx, vp, line, &Diag::Io { path: BString::from(what), err });
	if text.last() == Some(&b'\n') {
		text.pop();
	}
	BString::from(text)
}

/// Whether the redirections are being collected for the process of a
/// command that applies them itself ([`DeferPhase::Collect`]).
fn collecting(k: &Kernel, vp: &Vproc) -> bool {
	k.deferrals
		.iter()
		.any(|d| d.vproc == vp.vpid && d.phase == DeferPhase::Collect)
}

/// Redirection `r` to `target` of a command whose process applies its
/// redirections itself ([`DeferPhase::Collect`]): added to what the process
/// gets; nothing changes here. A bad one (a dup of no fd of the process, an
/// ambiguous target) is the process's step that fails it
/// ([`fail_in_child`]): `false`, and the stage ends ([`end_collect`]).
fn collect(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	unit: &Unit,
	r: &RedirIr,
	target: &BString,
	line: u32,
) -> bool {
	match child_steps(k, vp, cx, unit, r, target, line) {
		Ok(add) => {
			if let Some(d) = k.deferral(vp.vpid) {
				d.list.extend(add);
			}
			true
		},
		Err(d) => {
			fail_in_child(k, vp, cx, line, &d);
			false
		},
	}
}

/// The steps of redirection `r` to `target` for the process ([`collect`]),
/// or what makes it bad.
fn child_steps(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	unit: &Unit,
	r: &RedirIr,
	target: &BString,
	line: u32,
) -> Result<Vec<ChildRedir>, Diag> {
	let mut add = Vec::with_capacity(2);
	match r.op {
		RedirKind::Close => {
			add.push(ChildRedir::Close { fd: child_fd(r) });
		},
		RedirKind::DupIn | RedirKind::DupOut if target.as_slice() == b"-" => {
			add.push(ChildRedir::Close { fd: child_fd(r) });
		},
		RedirKind::DupIn | RedirKind::DupOut => {
			let (digits, moving) = match target.strip_suffix(b"-") {
				Some(d) => (d, true),
				None => (target.as_slice(), false),
			};
			if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) {
				let src: i32 = std::str::from_utf8(digits)
					.ok()
					.and_then(|s| s.parse().ok())
					.unwrap_or(-1);
				if !child_fd_open(k, vp, src) {
					let err = std::io::Error::other(crate::bash::fd::BadFd);
					return Err(Diag::Io { path: dup_name(unit, r, src, target), err });
				}
				let fd = child_fd(r);
				let diag = diag_prefix(k, cx, vp, line, &dup_name(unit, r, src, target));
				add.push(ChildRedir::Dup { fd, src, diag });
				if moving && src != fd {
					add.push(ChildRedir::Close { fd: src });
				}
			} else if r.op == RedirKind::DupOut && matches!(r.fd, RedirFdIr::Default) {
				// `>&file` is `&>file`.
				let flags = open_flags(k, vp, cx, RedirKind::OutErr, target);
				add.push(child_open(k, vp, cx, vec![1, 2], target, flags, line)?);
			} else {
				return Err(Diag::AmbiguousRedirect { word: target.clone() });
			}
		},
		RedirKind::OutErr | RedirKind::AppendErr => {
			let flags = open_flags(k, vp, cx, r.op, target);
			add.push(child_open(k, vp, cx, vec![1, 2], target, flags, line)?);
		},
		RedirKind::In
		| RedirKind::Out
		| RedirKind::Append
		| RedirKind::Clobber
		| RedirKind::ReadWrite => {
			let fd = child_fd(r);
			let flags = open_flags(k, vp, cx, r.op, target);
			add.push(child_open(k, vp, cx, vec![fd], target, flags, line)?);
		},
		RedirKind::HereDoc | RedirKind::HereString => {
			unreachable!("a here-document is never left to the process (`childable`)")
		},
	}
	Ok(add)
}

/// The fd redirection `r` of the process targets ([`child_steps`]): its
/// number or the operator's default. Never a `{var}` fd ([`childable`]):
/// the shell assigns those, so the line discard an arithmetic subscript
/// error makes there ([`assign_fd_var`]) never reaches the process's steps.
const fn child_fd(r: &RedirIr) -> i32 {
	match r.fd {
		RedirFdIr::Num(n) => n as i32,
		_ => default_fd(r.op),
	}
}

/// A redirection the engine finds bad (`d`) while it collects them for the
/// process ([`collect`]): the process's last step, which prints `d` and
/// exits with status 1 ([`ChildRedir::Fail`]) after the steps before it, as
/// bash's child fails it in its place. Refused here instead, it would leave
/// an earlier open never made: a FIFO's, whose other end would then wait for
/// ever.
fn fail_in_child(k: &mut Kernel, vp: &Vproc, cx: &mut Cx<'_>, line: u32, d: &Diag) {
	let text = BString::from(k.render_quiet(cx, vp, line, d));
	if let Some(def) = k.deferral(vp.vpid) {
		def.list.push(ChildRedir::Fail { text });
	}
}

/// The end of the redirection stage at a step the process fails
/// ([`fail_in_child`]): it applies none after it, as bash's child stops at
/// its first failed redirection, so no word after it is expanded either.
fn end_collect(vp: &mut Vproc, len: usize) {
	let sc = scratch(vp);
	let progress = &mut sc.io().redir;
	progress.done = len;
	progress.target = None;
	sc.logs[Slot::Redirs as usize].clear();
}

/// Whether `fd` is open in the process a command spawns at this point of
/// its collected redirections: inherited from the vproc, or set by one
/// collected before, and not closed since.
fn child_fd_open(k: &Kernel, vp: &Vproc, fd: i32) -> bool {
	let inherited = vp.fds.get(fd).is_some_and(FdRef::is_open);
	let list = k
		.deferrals
		.iter()
		.find(|d| d.vproc == vp.vpid)
		.map_or(&[][..], |d| d.list.as_slice());
	list.iter().fold(inherited, |open, redir| match redir {
		ChildRedir::Open { fds, .. } if fds.contains(&fd) => true,
		ChildRedir::Dup { fd: set, .. } if *set == fd => true,
		ChildRedir::Close { fd: closed } if *closed == fd => false,
		_ => open,
	})
}

/// The open of `target` onto `fds` by the process ([`ChildRedir::Open`]),
/// or the duplication `/dev/fd/N` (`/dev/stdin`, …) stands for. A
/// `/dev/fd/N` that names no fd of the process (not the shell's, not set by
/// an earlier redirection) is bad as a dup of it is (`3<&N`): the process
/// would take a descriptor of the host's own.
fn child_open(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	fds: Vec<i32>,
	target: &BString,
	flags: OpenFlags,
	line: u32,
) -> Result<ChildRedir, Diag> {
	if let Some(src) = dev_fd(target) {
		if !child_fd_open(k, vp, src) {
			let err = std::io::Error::other(crate::bash::fd::BadFd);
			return Err(Diag::Io { path: target.clone(), err });
		}
		if let [fd] = fds.as_slice() {
			let diag = diag_prefix(k, cx, vp, line, target);
			return Ok(ChildRedir::Dup { fd: *fd, src, diag });
		}
	}
	let diag = diag_prefix(k, cx, vp, line, target);
	let umask = state::umask(cx.store, vp).unwrap_or(0o022);
	Ok(ChildRedir::Open { fds, path: absolute(&vp.cwd, target), flags, mode: 0o666 & !umask, diag })
}

/// Print `d` and fail the redirection.
fn fail(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32, d: Diag) -> Halt {
	k.diag(cx, vp, line, d);
	Halt::Failed
}

/// zsh's message for a redirection failure.
fn zsh_msg(msg: String) -> Diag {
	Diag::Usage { msg: msg.into() }
}

/// zsh's `%e`: `strerror` with its first letter in lower case. Also the
/// command layer's message for an external that did not start.
pub(super) fn zsh_errno(err: &std::io::Error) -> String {
	let text = crate::bash::diag::strerror(err);
	let mut chars = text.chars();
	chars.next().map_or_else(String::new, |c| {
		let mut s: String = c.to_lowercase().collect();
		s.push_str(chars.as_str());
		s
	})
}

/// zsh `execcmd`'s pipe ends: when the op running is a pipeline stage, its
/// pipes are the first redirections of fd 1 (not the last stage) and fd 0
/// (not the first stage), so a redirection of them makes a multio (`print
/// x >file | cat` writes both).
#[inline(never)]
fn seed_pipeline(vp: &mut Vproc, unit: &Unit) {
	let Some(f) = vp.frames.last() else {
		return;
	};
	let base = matches!(f.kind, FrameKind::Stage)
		|| (vp.frames.len() == 1 && matches!(f.kind, FrameKind::Subshell | FrameKind::Job { .. }));
	if !base {
		return;
	}
	let pc = f.pc;
	let Some((i, n)) = unit
		.spawns
		.iter()
		.filter(|s| s.kind == SpawnKind::Pipeline)
		.find_map(|s| {
			s.stages
				.iter()
				.position(|st| st.entry == pc)
				.map(|i| (i, s.stages.len()))
		})
	else {
		return;
	};
	let pipe = |h: &FdRef| h.origin() == FdOrigin::Mem && h.kind() == Some(FileKind::Pipe);
	let out = vp.fds.get(1).filter(|h| i + 1 < n && pipe(h)).cloned();
	let inp = vp.fds.get(0).filter(|h| i > 0 && pipe(h)).cloned();
	let multio = &mut io(vp).zsh().multio;
	if let Some(h) = out {
		multio.push((1, true, vec![h]));
	}
	if let Some(h) = inp {
		multio.push((0, false, vec![h]));
	}
}

/// zsh `addfd`: put `h` on `fd`. With `multios`, a second redirection of
/// the same fd in this list joins the first: outputs go to all of them (a
/// tee), inputs are read one after the other (a cat); mixing directions is
/// `file mode mismatch on fd N`.
fn place(vp: &mut Vproc, fd: i32, h: FdRef, output: bool, multios: bool) -> Result<(), Diag> {
	if !multios {
		set_fd(vp, fd, Some(h));
		return Ok(());
	}
	let multio = &mut io(vp).zsh().multio;
	let Some(at) = multio.iter().position(|(f, ..)| *f == fd) else {
		multio.push((fd, output, vec![h.clone()]));
		set_fd(vp, fd, Some(h));
		return Ok(());
	};
	let (_, out, fds) = &mut multio[at];
	if *out != output {
		return Err(zsh_msg(format!("file mode mismatch on fd {fd}")));
	}
	fds.push(h);
	let all = fds.clone();
	let merged: Box<dyn File> = if output {
		Box::new(Tee::new(all))
	} else {
		Box::new(Cat { sources: all, at: 0 })
	};
	set_fd(vp, fd, Some(FdRef::open(merged, FdOrigin::Host)));
	Ok(())
}

/// The fd a zsh redirection targets: `{var}` allocates one ≥ 10 (zsh
/// `movefd`), refused when `var` is read-only, or under `noclobber` when it
/// holds an fd still open (zsh `execcmd`).
fn zsh_target_fd(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
) -> Result<i32, Diag> {
	match &r.fd {
		RedirFdIr::Default => Ok(default_fd(r.op)),
		RedirFdIr::Num(n) => Ok(*n as i32),
		RedirFdIr::Var(name) => {
			let readonly = state::lookup_declared(&k.root, cx.store, vp, name)
				.ok()
				.flatten()
				.is_some_and(|v| v.attrs.contains(crate::bash::store::Attrs::READONLY));
			if readonly {
				return Err(zsh_msg(format!(
					"can't allocate file descriptor to readonly parameter {}",
					name.as_bstr()
				)));
			}
			let clobber =
				state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Clobber).unwrap_or(true);
			if !clobber
				&& let Some(old) = var_fd(k, vp, cx, name)
				&& vp.fds.get(old).is_some_and(FdRef::is_open)
			{
				return Err(zsh_msg(format!(
					"can't clobber parameter {} containing file descriptor {old}",
					name.as_bstr()
				)));
			}
			Ok(super::jobctl::lowest_free_fd(k, vp, 10))
		},
	}
}

/// The flags zsh opens a file target with: `>` under `noclobber` refuses an
/// existing regular file (unless empty with `clobberempty`; zsh
/// `clobber_open`), `>>` under `noclobber` needs the file to exist unless
/// `appendcreate`; `|`/`!` forms ignore both. `Err` is the refusal or a
/// pending probe.
fn zsh_flags(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	target: &BString,
	line: u32,
) -> Result<OpenFlags, Halt> {
	let write = OpenFlags::WRITE.with(OpenFlags::CREATE);
	let append = matches!(r.op, RedirKind::Append | RedirKind::AppendErr);
	let output =
		matches!(r.op, RedirKind::Out | RedirKind::Clobber | RedirKind::OutErr | RedirKind::DupOut);
	if r.op == RedirKind::In {
		return Ok(OpenFlags::READ);
	}
	if r.op == RedirKind::ReadWrite {
		return Ok(OpenFlags::READ.with(write));
	}
	let clobber =
		r.clobber || state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Clobber).unwrap_or(true);
	if append {
		let create = clobber
			|| state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Appendcreate).unwrap_or(false);
		return Ok(if create {
			write.with(OpenFlags::APPEND)
		} else {
			OpenFlags::WRITE.with(OpenFlags::APPEND)
		});
	}
	if output && !clobber {
		let path = absolute(&vp.cwd, target);
		let st = match super::command::command_probe(k, cx, vp, &Probe::Stat { path, follow: true }) {
			Err(key) => return Err(Halt::Flow(Flow::Block(key))),
			Ok(ProbeResult::Stat(st)) => st,
			Ok(_) => None,
		};
		let empty_ok =
			state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Clobberempty).unwrap_or(false);
		if let Some(st) = st
			&& st.kind == StatKind::File
			&& !(empty_ok && st.size == 0)
		{
			let d = zsh_msg(format!("file exists: {}", target.as_bstr()));
			return Err(fail(k, vp, cx, line, d));
		}
	}
	Ok(write.with(OpenFlags::TRUNC))
}

/// `/dev/tty` in a vproc whose session has a terminal of its own (a `zpty`
/// command's, [`super::proc::VprocZsh::ctty`]): that terminal. zsh's
/// forked child opens its controlling terminal there; this process's
/// `/dev/tty` would be the shell's.
fn session_tty(vp: &Vproc, path: &[u8]) -> Option<FdRef> {
	if path != b"/dev/tty" {
		return None;
	}
	vp.zsh.as_deref().and_then(|z| z.ctty.0.clone())
}

/// Open `path` with `flags` (pollable) for a zsh redirection; a failure is
/// zsh's `ERRNO: path`.
fn zsh_open(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	path: &BString,
	flags: OpenFlags,
	line: u32,
) -> Result<FdRef, Halt> {
	if let Some(h) = session_tty(vp, path) {
		return Ok(h);
	}
	if let Some(src) = dev_fd(path) {
		return vp
			.fds
			.get(src)
			.cloned()
			.filter(FdRef::is_open)
			.ok_or_else(|| {
				let d = zsh_msg(format!("{}: bad file descriptor", path.as_bstr()));
				fail(k, vp, cx, line, d)
			});
	}
	let abs = absolute(&vp.cwd, path);
	let umask = state::umask(cx.store, vp).unwrap_or(0o022);
	let mut tcx = Context::from_waker(&k.waker);
	let res = match io(vp).redir.opening.as_mut() {
		Some(p) => p.poll(&mut tcx),
		None => match cx.host.fs().open(BStr::new(&abs), flags, 0o666 & !umask) {
			FsPoll::Ready(r) => Poll::Ready(r),
			FsPoll::Pending(mut p) => {
				let r = p.poll(&mut tcx);
				if r.is_pending() {
					io(vp).redir.opening = Some(p);
				}
				r
			},
		},
	};
	match res {
		Poll::Pending => Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path: abs }))),
		Poll::Ready(Ok(file)) => {
			io(vp).redir.opening = None;
			Ok(FdRef::open(file, FdOrigin::Host))
		},
		Poll::Ready(Err(err)) => {
			io(vp).redir.opening = None;
			let d = zsh_msg(format!("{}: {}", zsh_errno(&err), path.as_bstr()));
			Err(fail(k, vp, cx, line, d))
		},
	}
}

/// Apply one redirection of a zsh unit (zsh `execcmd`'s redirection loop
/// with `addfd`).
#[inline(never)]
fn zsh_install(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	target: &BString,
	line: u32,
	multios: bool,
) -> Result<(), Halt> {
	let place_on =
		|k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, fd: i32, h: FdRef, out: bool| {
			place(vp, fd, h, out, multios).map_err(|d| fail(k, vp, cx, line, d))
		};
	match r.op {
		RedirKind::HereDoc | RedirKind::HereString => {
			let fd = zsh_target_fd(k, vp, cx, r).map_err(|d| fail(k, vp, cx, line, d))?;
			let h = FdRef::mem(MemBuf::new(target.to_vec()));
			if let RedirFdIr::Var(name) = &r.fd {
				set_fd(vp, fd, Some(h));
				return assign_fd_var(k, vp, cx, name, fd, false, line);
			}
			place_on(k, vp, cx, fd, h, false)
		},
		RedirKind::Close => zsh_close(k, vp, cx, r, line),
		RedirKind::DupIn | RedirKind::DupOut if target.as_slice() == b"-" => {
			zsh_close(k, vp, cx, r, line)
		},
		RedirKind::DupIn | RedirKind::DupOut => {
			let output = r.op == RedirKind::DupOut;
			let src = if target.as_slice() == b"p" {
				// The coprocess: `>&p` writes its input, `<&p` reads its output.
				let Some(co) = vp.coprocs().last() else {
					return Err(fail(k, vp, cx, line, zsh_msg("no coprocess".into())));
				};
				Some(if output { co.write } else { co.read })
			} else if !target.is_empty() && target.iter().all(u8::is_ascii_digit) {
				std::str::from_utf8(target)
					.ok()
					.and_then(|s| s.parse().ok())
			} else {
				None
			};
			let Some(src) = src else {
				if output && matches!(r.fd, RedirFdIr::Default) {
					// `>& file`: `&> file`.
					restricted_write(k, vp, cx, line)?;
					let flags = zsh_flags(k, vp, cx, r, target, line)?;
					let h = zsh_open(k, vp, cx, target, flags, line)?;
					place_on(k, vp, cx, 1, h.clone(), true)?;
					return place_on(k, vp, cx, 2, h, true);
				}
				let d = zsh_msg(format!("file number expected: {}", target.as_bstr()));
				return Err(fail(k, vp, cx, line, d));
			};
			let Some(h) = vp.fds.get(src).cloned().filter(FdRef::is_open) else {
				return Err(fail(k, vp, cx, line, zsh_msg(format!("{src}: bad file descriptor"))));
			};
			let fd = zsh_target_fd(k, vp, cx, r).map_err(|d| fail(k, vp, cx, line, d))?;
			if let RedirFdIr::Var(name) = &r.fd {
				set_fd(vp, fd, Some(h));
				return assign_fd_var(k, vp, cx, name, fd, false, line);
			}
			place_on(k, vp, cx, fd, h, output)
		},
		RedirKind::OutErr | RedirKind::AppendErr => {
			restricted_write(k, vp, cx, line)?;
			let flags = zsh_flags(k, vp, cx, r, target, line)?;
			let h = zsh_open(k, vp, cx, target, flags, line)?;
			place_on(k, vp, cx, 1, h.clone(), true)?;
			place_on(k, vp, cx, 2, h, true)
		},
		RedirKind::In
		| RedirKind::Out
		| RedirKind::Append
		| RedirKind::Clobber
		| RedirKind::ReadWrite => {
			if r.op != RedirKind::In {
				restricted_write(k, vp, cx, line)?;
			}
			let fd = zsh_target_fd(k, vp, cx, r).map_err(|d| fail(k, vp, cx, line, d))?;
			let flags = zsh_flags(k, vp, cx, r, target, line)?;
			let h = zsh_open(k, vp, cx, target, flags, line)?;
			if let RedirFdIr::Var(name) = &r.fd {
				set_fd(vp, fd, Some(h));
				return assign_fd_var(k, vp, cx, name, fd, false, line);
			}
			// `<>` is both: never part of a multio.
			if r.op == RedirKind::ReadWrite {
				set_fd(vp, fd, Some(h));
				return Ok(());
			}
			place_on(k, vp, cx, fd, h, r.op != RedirKind::In)
		},
	}
}

/// zsh's `IS_WRITE_FILE` check under `restricted`: a redirection writing a
/// file fails before the file is opened.
fn restricted_write(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
) -> Result<(), Halt> {
	if state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Restricted).unwrap_or(false) {
		let d = zsh_msg("writing redirection not allowed in restricted mode".into());
		return Err(fail(k, vp, cx, line, d));
	}
	Ok(())
}

/// zsh `<&-` / `>&-`: close the fd; `{var}<&-` closes the fd `var` holds
/// (`parameter var does not contain a file descriptor` when it holds none,
/// refused for a read-only `var`, `failed to close file descriptor N` when
/// it is not open).
fn zsh_close(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	r: &RedirIr,
	line: u32,
) -> Result<(), Halt> {
	let fd = match &r.fd {
		RedirFdIr::Var(name) => {
			let readonly = state::lookup_declared(&k.root, cx.store, vp, name)
				.ok()
				.flatten()
				.is_some_and(|v| v.attrs.contains(crate::bash::store::Attrs::READONLY));
			if readonly {
				let d = zsh_msg(format!(
					"can't close file descriptor from readonly parameter {}",
					name.as_bstr()
				));
				return Err(fail(k, vp, cx, line, d));
			}
			let Some(fd) = var_fd(k, vp, cx, name) else {
				let d =
					zsh_msg(format!("parameter {} does not contain a file descriptor", name.as_bstr()));
				return Err(fail(k, vp, cx, line, d));
			};
			if !vp.fds.get(fd).is_some_and(FdRef::is_open) {
				let d = zsh_msg(format!("failed to close file descriptor {fd}: bad file descriptor"));
				return Err(fail(k, vp, cx, line, d));
			}
			fd
		},
		RedirFdIr::Num(n) => *n as i32,
		RedirFdIr::Default => default_fd(r.op),
	};
	set_fd(vp, fd, None);
	super::exec::coproc_fd_closed(k, vp, cx, fd);
	Ok(())
}

/// The most a tee holds that not every target has taken yet; a write past
/// it waits.
const TEE_HOLD: usize = 64 << 10;

/// A write of at most this many bytes goes into a tee whole or not at all,
/// as a pipe keeps a write of at most `PIPE_BUF` bytes whole. It is Linux's
/// `PIPE_BUF`, used on every platform: macOS's is 512, so the tee keeps at
/// least as much whole as a pipe does there. This keeps whole a write the
/// shell makes to the tee itself (a builtin's, a diagnostic, a write through
/// a duplicate or a nested tee), so another writer's bytes never land
/// inside it. A program's output does not come in its own writes: the tee
/// has no OS handle, so a program writing to it is pumped, and its pump
/// reads up to 64 KiB from the program's pipe at once and hands the chunk
/// to the tee in one write. That read can end inside one of the program's
/// writes, and a chunk longer than this is split where a slow target leaves
/// less room, so another writer's line can still land inside a program's.
/// zsh keeps it whole because every writer writes into its tee process's
/// pipe; closing it needs a pipe of the tee's own that every writer shares.
const TEE_WHOLE: usize = 4096;

/// zsh's multio tee (`closemn` for output). Like zsh's tee process, which
/// reads what the command wrote from a pipe, the tee owns what it takes: a
/// write queues its bytes and returns, and the queue goes to each target in
/// order, one write after another, as the tee is polled (a later write, a
/// settle, a flush, an idle pump). A tee is one fd object that several
/// writers share (an external's pump, then a builtin), and its duplicates
/// share its queue, so no write's progress or failure is another's: each
/// target goes through each write on its own, a write is `Pending` only
/// when it took nothing, a write of at most [`TEE_WHOLE`] bytes is taken
/// whole (which keeps the shell's own writes whole, not a program's pumped
/// output: see [`TEE_WHOLE`]), and a target whose chunk failed is skipped for
/// the rest of the write that chunk belongs to (a target that is gone is
/// skipped); the next write starts afresh. A tee reports no target's
/// failure to its writers. The tee polls its targets with a waker of its
/// own, which wakes every caller waiting on the tee ([`Waiters`]): a target
/// keeps one waker (a host file's readiness watch keeps the latest), so a
/// caller's own waker there would be replaced by the next caller's, and the
/// first would sleep on bytes another caller moved out, or that no caller
/// moves once the other is cancelled. Each write the tee takes comes with a
/// [`Mark`] ([`File::poll_write_marked`]), done once every target has
/// written that write out, so a writer that settles its marks counts its
/// bytes only once they are out of the tee: an engine command's output,
/// [`FdRef::poll_write_out`]'s writers (`syswrite`, a job notice), a pump.
/// What the queue holds when the tee's last handle closes is lost; none of
/// it is a write whose writer settled its mark.
struct Tee(Arc<TeeShared>);

struct TeeShared {
	state:   parking_lot::Mutex<TeeState>,
	waiters: Arc<Waiters>,
	/// Wakes `waiters`: the waker the targets are polled with.
	waker:   Waker,
}

/// The callers of a tee that may be waiting on it: per waker, how many of
/// its calls registered it, and the entry's generation. All are woken
/// together, and taken off, when a target the tee polled is ready; when a
/// call moved the queue on, all but that call's own caller are, and that
/// caller's waker too, once, when another call registered it. A call
/// registers its waker before it polls the targets, so no target's wake can
/// come before it, and takes its registration back once it is `Ready`: a
/// waiter is a call still waiting, or one cancelled while it waited, until
/// the next wake takes it off. A release names the generation its call
/// registered under, so a call whose entry a wake took off since cannot
/// take a newer call's registration of the same waker.
#[derive(Default)]
struct Waiters(parking_lot::Mutex<WaitList>);

#[derive(Default)]
struct WaitList {
	/// Each waker, its registrations, and its entry's generation.
	entries: Vec<(Waker, usize, u64)>,
	/// The generation the next new entry gets.
	next:    u64,
}

impl Waiters {
	/// Registers `waker` for one call: the generation to release it with.
	fn add(&self, waker: &Waker) -> u64 {
		let mut list = self.0.lock();
		if let Some((_, calls, generation)) =
			list.entries.iter_mut().find(|(w, ..)| w.will_wake(waker))
		{
			*calls += 1;
			return *generation;
		}
		let generation = list.next;
		list.next += 1;
		list.entries.push((waker.clone(), 1, generation));
		generation
	}

	/// Takes back one registration under `generation`, by a call that is
	/// `Ready`; none if a wake took that entry off since. The generation
	/// alone names the entry: a waker's clone need not `will_wake` it.
	fn release(&self, generation: u64) {
		let mut list = self.0.lock();
		if let Some(i) = list.entries.iter().position(|(.., g)| *g == generation) {
			list.entries[i].1 -= 1;
			if list.entries[i].1 == 0 {
				list.entries.swap_remove(i);
			}
		}
	}

	/// Wakes every waiter but `caller`, which stays registered throughout:
	/// a target's wake that comes while the others are woken finds it. The
	/// engine polls every vproc with one waker, so another registration
	/// under `caller`'s waker (its count above the caller's own one) can be
	/// another vproc waiting on the tee: then `caller`'s waker is woken too,
	/// still registered, and the engine polls them all again. Its count goes
	/// back to 1, the caller's own call, since the calls it woke register
	/// again when they are polled. A registration whose call is gone (one
	/// cancelled while it waited, or an earlier poll of a wait polled again)
	/// so wakes the caller once, not on every later move.
	fn wake_others(&self, caller: &Waker) {
		let wake: Vec<Waker> = {
			let mut list = self.0.lock();
			let mut wake = Vec::new();
			list.entries.retain_mut(|(w, calls, _)| {
				if w.will_wake(caller) {
					if *calls > 1 {
						wake.push(w.clone());
						*calls = 1;
					}
					true
				} else {
					wake.push(w.clone());
					false
				}
			});
			wake
		};
		for w in wake {
			w.wake();
		}
	}
}

impl Wake for Waiters {
	fn wake(self: Arc<Self>) {
		self.wake_by_ref();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		let entries = std::mem::take(&mut self.0.lock().entries);
		for (w, ..) in entries {
			w.wake();
		}
	}
}

struct TeeState {
	targets: Vec<FdRef>,
	/// Writes taken that not every target has had, oldest first, each with
	/// its sequence number and its writer's mark, done once it leaves the
	/// queue: every target has taken it and settled the chunk it took last.
	queue:   std::collections::VecDeque<(u64, Vec<u8>, Mark)>,
	/// Bytes in `queue`.
	queued:  usize,
	/// The sequence number the next write gets.
	next:    u64,
	/// Each target's place in the queue.
	places:  Vec<Place>,
	/// The last drive moved the queue on: a target took bytes or settled a
	/// chunk, or the queue let a write go.
	moved:   bool,
}

/// Where one target of a tee is.
#[derive(Clone, Debug, Default)]
struct Place {
	/// The write it is on.
	seq:  u64,
	/// How much of that write it took.
	off:  usize,
	/// The chunk it took last. It belongs to the write the target is on: the
	/// target moves to the next write only once that chunk settled.
	last: Option<Mark>,
}

impl Tee {
	fn new(targets: Vec<FdRef>) -> Self {
		let waiters = Arc::new(Waiters::default());
		Self(Arc::new(TeeShared {
			state: parking_lot::Mutex::new(TeeState {
				places: vec![Place::default(); targets.len()],
				targets,
				queue: std::collections::VecDeque::new(),
				queued: 0,
				next: 0,
				moved: false,
			}),
			waker: Waker::from(Arc::clone(&waiters)),
			waiters,
		}))
	}

	/// Runs `f` on the state with the tee's own waker, the caller of `cx`
	/// registered among its waiters for the call. Once the lock is let go,
	/// the other waiters are woken if `f` moved the queue on (a write that
	/// waited for room, or a settle for what another caller moved out, looks
	/// again), and a call that is `Ready` takes its registration back.
	fn with<T>(
		&self,
		cx: &Context<'_>,
		f: impl FnOnce(&mut TeeState, &mut Context<'_>) -> Poll<T>,
	) -> Poll<T> {
		let generation = self.0.waiters.add(cx.waker());
		let mut tcx = Context::from_waker(&self.0.waker);
		let (out, moved) = {
			let mut s = self.0.state.lock();
			let out = f(&mut s, &mut tcx);
			(out, std::mem::take(&mut s.moved))
		};
		if moved {
			self.0.waiters.wake_others(cx.waker());
		}
		if out.is_ready() {
			self.0.waiters.release(generation);
		}
		out
	}
}

impl TeeState {
	/// Moves the queue on to every target; `Ready` once every target has
	/// taken every queued byte, its last chunk is out and it has settled (a
	/// target that is a tee itself moves its own queue then). Each target
	/// settles the chunk it took last before it takes the next.
	fn drive(&mut self, cx: &mut Context<'_>) -> Poll<()> {
		let first = self.queue.front().map_or(self.next, |(seq, ..)| *seq);
		let mut done = true;
		for (t, place) in self.targets.iter().zip(&mut self.places) {
			loop {
				if let Some(taken) = &place.last {
					match t.poll_settle_marked(cx, std::slice::from_ref(taken)) {
						Poll::Ready(settled) => {
							// A failed chunk skips the rest of its own write.
							if settled.is_err() {
								place.off = usize::MAX;
							}
							place.last = None;
							self.moved = true;
						},
						Poll::Pending => {
							done = false;
							break;
						},
					}
				}
				let Some((_, bytes, _)) = usize::try_from(place.seq - first)
					.ok()
					.and_then(|i| self.queue.get(i))
				else {
					// Every queued byte is the target's: it settles, which
					// moves a nested tee's own queue on.
					if t.poll_settle(cx).is_pending() {
						done = false;
					}
					break;
				};
				if place.off >= bytes.len() {
					place.seq += 1;
					place.off = 0;
					continue;
				}
				match t.poll_write_marked(cx, &bytes[place.off..]) {
					Poll::Ready(Ok((n, taken))) if n > 0 => {
						place.off += n;
						place.last = taken;
						self.moved = true;
					},
					// The target is gone: skipped for the rest of this write.
					Poll::Ready(_) => {
						place.off = usize::MAX;
						self.moved = true;
					},
					Poll::Pending => {
						done = false;
						break;
					},
				}
			}
		}
		while let Some((seq, bytes, _)) = self.queue.front()
			&& self.places.iter().all(|p| p.seq > *seq)
		{
			self.queued -= bytes.len();
			if let Some((.., mark)) = self.queue.pop_front() {
				mark.finish(Ok(()));
			}
			self.moved = true;
		}
		if done && self.queue.is_empty() {
			Poll::Ready(())
		} else {
			Poll::Pending
		}
	}
}

impl File for Tee {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<std::io::Result<usize>> {
		Poll::Ready(Ok(0))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
		self.poll_write_marked(cx, buf).map_ok(|(n, _)| n)
	}

	/// Takes what fits beside what the targets have not taken yet, and
	/// moves the queue on; `Pending`, with nothing taken, while the tee
	/// holds [`TEE_HOLD`] bytes, or while a write of at most [`TEE_WHOLE`]
	/// bytes does not fit whole. A longer write takes what fits, as a pipe
	/// takes a write longer than `PIPE_BUF`; that is how a pump's chunk of a
	/// program's output can be split (see [`TEE_WHOLE`]). Room is not
	/// reserved for a waiting write: under sustained contention, longer
	/// writes can take the room a waiting short write needs, and the short
	/// write goes in at the first poll that finds room for it. The write's
	/// mark is done once every target has written it out
	/// ([`File::poll_settle_marked`]).
	fn poll_write_marked(
		&mut self,
		cx: &mut Context<'_>,
		buf: &[u8],
	) -> Poll<std::io::Result<(usize, Option<Mark>)>> {
		if buf.is_empty() {
			return Poll::Ready(Ok((0, None)));
		}
		self.with(cx, |s, tcx| {
			let _ = s.drive(tcx);
			let room = TEE_HOLD.saturating_sub(s.queued);
			if room == 0 || (buf.len() <= TEE_WHOLE && buf.len() > room) {
				// The queue holds bytes a target has not taken, and that
				// target holds the tee's waker, which wakes this caller.
				return Poll::Pending;
			}
			let n = buf.len().min(room);
			let seq = s.next;
			let mark = Mark::new();
			s.queue.push_back((seq, buf[..n].to_vec(), mark.clone()));
			s.next += 1;
			s.queued += n;
			let _ = s.drive(tcx);
			Poll::Ready(Ok((n, Some(mark))))
		})
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
		self.with(cx, |s, tcx| {
			std::task::ready!(s.drive(tcx));
			for t in &s.targets {
				if t.poll_flush(tcx).is_pending() {
					return Poll::Pending;
				}
			}
			Poll::Ready(Ok(()))
		})
	}

	/// Ready once every target has taken every byte the tee took, its last
	/// chunk is out, and it has settled.
	fn poll_settle(&mut self, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
		self.with(cx, |s, tcx| s.drive(tcx).map(Ok))
	}

	/// Ready once every write whose mark is in `marks` has left the queue:
	/// every target has taken it and settled the chunk it took last. With
	/// no marks, [`File::poll_settle`]: every write the tee took. A tee
	/// reports no target's failure to its writers, so this is `Ok`.
	fn poll_settle_marked(
		&mut self,
		cx: &mut Context<'_>,
		marks: &[Mark],
	) -> Poll<std::io::Result<()>> {
		if marks.is_empty() {
			return self.poll_settle(cx);
		}
		self.with(cx, |s, tcx| {
			let _ = s.drive(tcx);
			if marks.iter().all(Mark::is_done) {
				Poll::Ready(Ok(()))
			} else {
				Poll::Pending
			}
		})
	}

	fn seek(&mut self, _pos: SeekFrom) -> std::io::Result<u64> {
		Err(std::io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	/// The same tee: a duplicate shares the queue, so what each handle
	/// writes reaches the targets in the order the tee took it.
	fn dup(&self) -> std::io::Result<Box<dyn File>> {
		Ok(Box::new(Self(Arc::clone(&self.0))))
	}
}

/// zsh's multio cat (`closemn` for input): reads each source to its end in
/// turn.
struct Cat {
	sources: Vec<FdRef>,
	at:      usize,
}

impl File for Cat {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<std::io::Result<usize>> {
		while let Some(src) = self.sources.get(self.at) {
			match src.poll_read(cx, buf) {
				Poll::Ready(Ok(0)) => self.at += 1,
				other => return other,
			}
		}
		Poll::Ready(Ok(0))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<std::io::Result<usize>> {
		Poll::Ready(Err(std::io::Error::other(crate::bash::fd::BadFd)))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> std::io::Result<u64> {
		Err(std::io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> std::io::Result<Box<dyn File>> {
		Ok(Box::new(Self { sources: self.sources.clone(), at: self.at }))
	}
}

/// Open `path` (pollable) and install it on every fd of `fds`.
fn open_into(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	fds: &[i32],
	path: &BString,
	flags: OpenFlags,
	line: u32,
) -> Result<(), Halt> {
	if let Some(h) = session_tty(vp, path) {
		for &fd in fds {
			set_fd(vp, fd, Some(h.clone()));
		}
		return Ok(());
	}
	if let Some(src) = dev_fd(path) {
		let Some(h) = vp.fds.get(src).cloned().filter(FdRef::is_open) else {
			k.diag(cx, vp, line, Diag::Io {
				path: path.clone(),
				err:  std::io::Error::other(crate::bash::fd::BadFd),
			});
			return Err(Halt::Failed);
		};
		for &fd in fds {
			set_fd(vp, fd, Some(h.clone()));
		}
		return Ok(());
	}
	let abs = absolute(&vp.cwd, path);
	// The vproc's own `umask` (a subshell's applies to its redirections).
	let umask = state::umask(cx.store, vp).unwrap_or(0o022);
	let mut tcx = Context::from_waker(&k.waker);
	let res = match io(vp).redir.opening.as_mut() {
		Some(p) => p.poll(&mut tcx),
		None => match cx.host.fs().open(BStr::new(&abs), flags, 0o666 & !umask) {
			FsPoll::Ready(r) => Poll::Ready(r),
			FsPoll::Pending(mut p) => {
				let r = p.poll(&mut tcx);
				if r.is_pending() {
					io(vp).redir.opening = Some(p);
				}
				r
			},
		},
	};
	match res {
		Poll::Pending => Err(Halt::Flow(Flow::Block(WaitKey::Fs { op: FsOp::Open, path: abs }))),
		Poll::Ready(Ok(file)) => {
			io(vp).redir.opening = None;
			let h = FdRef::open(file, FdOrigin::Host);
			for &fd in fds {
				set_fd(vp, fd, Some(h.clone()));
			}
			Ok(())
		},
		Poll::Ready(Err(err)) => {
			io(vp).redir.opening = None;
			let d =
				if err.kind() == std::io::ErrorKind::AlreadyExists && flags.contains(OpenFlags::EXCL) {
					Diag::NoClobber { path: path.clone() }
				} else {
					Diag::Io { path: path.clone(), err }
				};
			k.diag(cx, vp, line, d);
			Err(Halt::Failed)
		},
	}
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use std::{
		io::{Read, Write},
		os::unix::fs::OpenOptionsExt,
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		task::{Wake, Waker},
		time::{Duration, Instant},
	};

	use super::*;
	use crate::sys::StdFile;

	/// Records a wake and unparks the test thread.
	struct Woken(AtomicBool, std::thread::Thread);

	impl Wake for Woken {
		fn wake(self: Arc<Self>) {
			self.0.store(true, Ordering::SeqCst);
			self.1.unpark();
		}
	}

	/// Drives `poll` to `Ready` on the test thread, polling again only once
	/// its waker was woken: a `Pending` with no wake registered fails.
	fn ready<T>(what: &str, mut poll: impl FnMut(&mut Context<'_>) -> Poll<T>) -> T {
		let woken = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
		let waker = Waker::from(Arc::clone(&woken));
		let mut cx = Context::from_waker(&waker);
		let start = Instant::now();
		loop {
			if let Poll::Ready(v) = poll(&mut cx) {
				return v;
			}
			while !woken.0.swap(false, Ordering::SeqCst) {
				assert!(start.elapsed() < Duration::from_secs(5), "DEADLINE fired: {what}");
				std::thread::park_timeout(Duration::from_millis(100));
			}
		}
	}

	/// One poll with a waker nothing waits on.
	fn once<T>(poll: impl FnOnce(&mut Context<'_>) -> Poll<T>) -> Poll<T> {
		poll(&mut Context::from_waker(Waker::noop()))
	}

	/// A host file of `file` on the writer-thread route (the test's own
	/// process), as an engine fd object.
	fn host(file: std::fs::File) -> FdRef {
		FdRef::from_file(Box::new(StdFile::new(file)))
	}

	/// A FIFO in `dir`, made by mkfifo(1): the engine's modules hold no
	/// unsafe code.
	fn fifo(dir: &tempfile::TempDir) -> std::path::PathBuf {
		fifo_named(dir, "fifo")
	}

	/// The FIFO `dir/name`, made by mkfifo(1).
	fn fifo_named(dir: &tempfile::TempDir, name: &str) -> std::path::PathBuf {
		let path = dir.path().join(name);
		let made = std::process::Command::new("mkfifo")
			.arg(&path)
			.status()
			.unwrap();
		assert!(made.success(), "mkfifo: {made}");
		path
	}

	/// A non-blocking reader of the FIFO at `path`.
	fn reader(path: &std::path::Path) -> std::fs::File {
		std::fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)
			.unwrap()
	}

	/// fd 3 on the FIFO at `path`, whose first reader has come and gone, and
	/// `/dev/null`.
	fn targets(path: &std::path::Path) -> (FdRef, FdRef) {
		let first = reader(path);
		let fd3 = host(std::fs::OpenOptions::new().write(true).open(path).unwrap());
		let null = host(
			std::fs::OpenOptions::new()
				.write(true)
				.open("/dev/null")
				.unwrap(),
		);
		drop(first);
		(fd3, null)
	}

	/// What a new reader of the FIFO finds: `b\n` if the tee wrote it.
	fn assert_reads_b(second: &mut std::fs::File) {
		let mut line = [0u8; 2];
		let read = second.read(&mut line);
		assert!(
			matches!(read, Ok(2)) && &line == b"b\n",
			"the new reader got {read:?} {line:?}: the tee dropped `b`"
		);
	}

	// Failure mode: zsh multios, fd 3 a FIFO whose reader left: `printf a
	// >&3 >/dev/null` hands `a` to the FIFO's writer thread, where it fails.
	// A new reader opens the FIFO, and `printf b >&3 >/dev/null` (another
	// tee over the same fd 3) took `a`'s error as its own and dropped `b`.
	// A chunk's error is only its writer's: the second tee hands `b` off and
	// the new reader reads it.
	#[test]
	fn a_tee_after_another_tees_failed_chunk_writes_its_own_bytes() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_tee_after_another_tees_failed_chunk_writes_its_own_bytes"),
			|| {
				let dir = tempfile::tempdir().unwrap();
				let path = fifo(&dir);
				let (fd3, null) = targets(&path);
				let mut a = Tee::new(vec![fd3.clone(), null.clone()]);
				let wrote = ready("the first tee's write", |cx| a.poll_write(cx, b"a\n"));
				assert!(matches!(wrote, Ok(2)), "{wrote:?}");
				let _ = ready("the first tee's settle", |cx| a.poll_settle(cx));
				drop(a);
				let mut second = reader(&path);
				let mut b = Tee::new(vec![fd3, null]);
				let wrote = ready("the second tee's write", |cx| b.poll_write(cx, b"b\n"));
				assert!(matches!(wrote, Ok(2)), "{wrote:?}");
				let _ = ready("the second tee's settle", |cx| b.poll_settle(cx));
				assert_reads_b(&mut second);
			},
		);
	}

	// Failure mode: one tee is the fd object of several writers (`exec 3>fifo
	// 3>/dev/null`, then an external's output pump and a builtin): the first
	// write's chunk to the FIFO failed, the tee kept its mark, and the next
	// writer's `b` through the same tee took that failure as its own and
	// skipped the FIFO. A target's failure belongs to the write that met it.
	#[test]
	fn a_tee_whose_earlier_write_failed_writes_the_next_writers_bytes() {
		crate::sys::in_blocking_writer_process(
			concat!(
				module_path!(),
				"::a_tee_whose_earlier_write_failed_writes_the_next_writers_bytes"
			),
			|| {
				let dir = tempfile::tempdir().unwrap();
				let path = fifo(&dir);
				let (fd3, null) = targets(&path);
				let mut tee = Tee::new(vec![fd3.clone(), null]);
				let wrote = ready("the first write", |cx| tee.poll_write(cx, b"a\n"));
				assert!(matches!(wrote, Ok(2)), "{wrote:?}");
				// `a`'s chunk has failed (fd 3's thread is idle), and the tee
				// still holds its mark.
				let _ = ready("fd 3's writer thread", |cx| fd3.poll_settle(cx));
				let mut second = reader(&path);
				let wrote = ready("the next write", |cx| tee.poll_write(cx, b"b\n"));
				assert!(matches!(wrote, Ok(2)), "{wrote:?}");
				let _ = ready("the tee's settle", |cx| tee.poll_settle(cx));
				assert_reads_b(&mut second);
			},
		);
	}

	/// Opens the FIFO at `path` for a reader that stays and fills its pipe
	/// through a writer of its own: the reader, and how many bytes fill it.
	fn full_fifo(path: &std::path::Path) -> (std::fs::File, usize) {
		let held = reader(path);
		let mut filler = std::fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)
			.unwrap();
		let mut filled = 0;
		// Full to the byte: 4096-byte writes, then single bytes, until the
		// pipe takes none (a pipe may keep room for less than a page).
		for size in [4096, 1] {
			loop {
				match filler.write(&vec![b'F'; size]) {
					Ok(n) => filled += n,
					Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
					Err(e) => panic!("filling the FIFO: {e}"),
				}
			}
		}
		(held, filled)
	}

	/// Everything `reader` holds now.
	fn read_all(reader: &mut std::fs::File) -> Vec<u8> {
		let mut all = Vec::new();
		let mut buf = [0u8; 8192];
		loop {
			match reader.read(&mut buf) {
				Ok(0) => return all,
				Ok(n) => all.extend_from_slice(&buf[..n]),
				Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return all,
				Err(e) => panic!("reading the FIFO: {e}"),
			}
		}
	}

	// Failure mode: a tee shared by two writers kept one write's progress
	// for the other. A's 128 KiB went to `/dev/null` whole and to the full
	// FIFO in part, and its call was left `Pending`; B's `b` through the same
	// tee was measured against A's offsets and never written. The tee owns
	// what it takes, and each write goes to each target in order: the
	// reader gets the filler, then what the tee took of A, then `b`.
	#[test]
	fn a_tee_shared_by_two_writers_writes_each_ones_bytes_in_order() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_tee_shared_by_two_writers_writes_each_ones_bytes_in_order"),
			|| {
				let dir = tempfile::tempdir().unwrap();
				let path = fifo(&dir);
				let (mut held, filled) = full_fifo(&path);
				let fd3 = host(std::fs::OpenOptions::new().write(true).open(&path).unwrap());
				let null = host(
					std::fs::OpenOptions::new()
						.write(true)
						.open("/dev/null")
						.unwrap(),
				);
				let mut tee = Tee::new(vec![fd3, null]);
				// A writes once and leaves it there. The tee has room, so it
				// takes some of A: a `Pending` that had still sent bytes on
				// is the shared progress this test is about.
				let big = vec![b'A'; 128 << 10];
				let took = match once(|cx| tee.poll_write(cx, &big)) {
					Poll::Ready(Ok(n)) if n > 0 => n,
					other => panic!("the tee took none of A's write: {other:?}"),
				};
				let want = filled + took + 2;
				let drain = std::thread::spawn(move || {
					let start = Instant::now();
					let mut all = Vec::new();
					while all.len() < want && start.elapsed() < Duration::from_secs(5) {
						all.extend(read_all(&mut held));
						std::thread::sleep(Duration::from_millis(5));
					}
					all
				});
				let wrote = ready("B's write", |cx| tee.poll_write(cx, b"b\n"));
				assert!(matches!(wrote, Ok(2)), "{wrote:?}");
				let _ = ready("the tee's settle", |cx| tee.poll_settle(cx));
				let all = drain.join().unwrap();
				let mut expected = vec![b'F'; filled];
				expected.extend(std::iter::repeat_n(b'A', took));
				expected.extend_from_slice(b"b\n");
				assert!(
					all == expected,
					"the reader got {} bytes, {} of A's ({took} taken), ending {:?}",
					all.len(),
					count(&all, b'A'),
					String::from_utf8_lossy(&all[all.len().saturating_sub(4)..])
				);
			},
		);
	}

	// Failure mode: as above, and A's chunk to the FIFO then failed (its
	// reader left; a new reader came): B took A's failure for its own and
	// skipped the FIFO. A failure belongs to the write that met it: the new
	// reader gets `b` and none of A's bytes.
	#[test]
	fn a_tee_write_another_writer_left_unfinished_keeps_the_next_writers_bytes() {
		crate::sys::in_blocking_writer_process(
			concat!(
				module_path!(),
				"::a_tee_write_another_writer_left_unfinished_keeps_the_next_writers_bytes"
			),
			|| {
				let dir = tempfile::tempdir().unwrap();
				let path = fifo(&dir);
				let (held, _) = full_fifo(&path);
				let fd3 = host(std::fs::OpenOptions::new().write(true).open(&path).unwrap());
				let null = host(
					std::fs::OpenOptions::new()
						.write(true)
						.open("/dev/null")
						.unwrap(),
				);
				let mut tee = Tee::new(vec![fd3.clone(), null]);
				let big = vec![b'A'; 128 << 10];
				let a = once(|cx| tee.poll_write(cx, &big));
				assert!(
					matches!(a, Poll::Ready(Ok(n)) if n > 0),
					"the tee took none of A's write: {a:?}"
				);
				// The FIFO's reader leaves: A's chunk there fails.
				drop(held);
				let _ = ready("fd 3's writer thread", |cx| fd3.poll_settle(cx));
				let mut second = reader(&path);
				// The pipe keeps the filler for its next reader: read it first,
				// so `b` has room.
				let mut all = read_all(&mut second);
				let wrote = ready("B's write", |cx| tee.poll_write(cx, b"b\n"));
				assert!(matches!(wrote, Ok(2)), "{wrote:?}");
				let _ = ready("the tee's settle", |cx| tee.poll_settle(cx));
				all.extend(read_all(&mut second));
				assert!(
					all.ends_with(b"b\n") && !all.contains(&b'A'),
					"the new reader got {} bytes, {} of A's, ending {:?}",
					all.len(),
					count(&all, b'A'),
					String::from_utf8_lossy(&all[all.len().saturating_sub(4)..])
				);
			},
		);
	}

	/// How many of `bytes` are `byte`.
	fn count(bytes: &[u8], byte: u8) -> usize {
		bytes.iter().fold(0, |n, &c| n + usize::from(c == byte))
	}

	/// The FIFO at `dir/name`, full, with the reader that holds it, how many
	/// bytes fill it, and fd 3 on it.
	fn full_target(dir: &tempfile::TempDir, name: &str) -> (std::fs::File, usize, FdRef) {
		let path = fifo_named(dir, name);
		let (held, filled) = full_fifo(&path);
		let fd = host(std::fs::OpenOptions::new().write(true).open(&path).unwrap());
		(held, filled, fd)
	}

	/// Reads `reader` until it holds `want` bytes, for at most 5 s.
	fn read_up_to(reader: &mut std::fs::File, want: usize) -> Vec<u8> {
		let start = Instant::now();
		let mut all = Vec::new();
		while all.len() < want && start.elapsed() < Duration::from_secs(5) {
			all.extend(read_all(reader));
			std::thread::sleep(Duration::from_millis(5));
		}
		all
	}

	/// `filled` bytes of filler, `ones` of `1`, then `tail`.
	fn expected(filled: usize, ones: usize, tail: &[u8]) -> Vec<u8> {
		let mut all = vec![b'F'; filled];
		all.extend(std::iter::repeat_n(b'1', ones));
		all.extend_from_slice(tail);
		all
	}

	// Failure mode: a tee whose target is a tee itself: the outer tee handed
	// the inner one `x` and moved on, while the inner tee held `x` behind its
	// own busy target. With the outer tee waiting on another full target,
	// nothing polled the inner tee again, so `x` never left, and a reader
	// that drains the other target only once it has `x` waited for ever. The
	// outer tee settles each target, which moves a nested tee's queue.
	#[test]
	fn a_tee_in_a_tee_moves_its_queue_while_the_outer_tee_waits() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_tee_in_a_tee_moves_its_queue_while_the_outer_tee_waits"),
			|| {
				let dir = tempfile::tempdir().unwrap();
				let (mut p_held, p_filled, p) = full_target(&dir, "p");
				let (mut q_held, q_filled, q) = full_target(&dir, "q");
				let inner = FdRef::from_file(Box::new(Tee::new(vec![p])));
				let mut outer = Tee::new(vec![inner, q]);
				// Both targets' writer threads wait on their full pipes.
				let first = once(|cx| outer.poll_write(cx, &[b'1'; 4096]));
				assert!(matches!(first, Poll::Ready(Ok(4096))), "{first:?}");
				let second = once(|cx| outer.poll_write(cx, b"x"));
				assert!(matches!(second, Poll::Ready(Ok(1))), "{second:?}");
				let consumer = std::thread::spawn(move || {
					let p_got = read_up_to(&mut p_held, p_filled + 4097);
					let q_got = read_up_to(&mut q_held, q_filled + 4097);
					(p_got, q_got)
				});
				let _ = ready("the outer tee's settle", |cx| outer.poll_settle(cx));
				let (p_got, q_got) = consumer.join().unwrap();
				assert!(p_got == expected(p_filled, 4096, b"x"), "p got {} bytes", p_got.len());
				assert!(q_got == expected(q_filled, 4096, b"x"), "q got {} bytes", q_got.len());
			},
		);
	}

	// Failure mode: a duplicate of a tee (`exec 4>&3`, fd 3 a tee) kept a
	// queue of its own, so its `b` reached the FIFO before the `a` the tee
	// took first and still held. A duplicate is the same tee: its bytes come
	// after the tee's, even when only the duplicate is polled.
	#[test]
	fn a_duplicate_of_a_tee_writes_after_what_the_tee_took_first() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_duplicate_of_a_tee_writes_after_what_the_tee_took_first"),
			|| {
				let dir = tempfile::tempdir().unwrap();
				let (mut held, filled, p) = full_target(&dir, "p");
				let null = host(
					std::fs::OpenOptions::new()
						.write(true)
						.open("/dev/null")
						.unwrap(),
				);
				let mut tee = Tee::new(vec![p, null]);
				let first = once(|cx| tee.poll_write(cx, &[b'1'; 4096]));
				assert!(matches!(first, Poll::Ready(Ok(4096))), "{first:?}");
				let a = once(|cx| tee.poll_write(cx, b"a"));
				assert!(matches!(a, Poll::Ready(Ok(1))), "{a:?}");
				let mut dup = tee.dup().unwrap();
				let b = once(|cx| dup.poll_write(cx, b"b"));
				assert!(matches!(b, Poll::Ready(Ok(1))), "{b:?}");
				let drain = std::thread::spawn(move || read_up_to(&mut held, filled + 4098));
				let _ = ready("the duplicate's settle", |cx| dup.poll_settle(cx));
				let got = drain.join().unwrap();
				assert!(
					got == expected(filled, 4096, b"ab"),
					"the FIFO got {} bytes, ending {:?}",
					got.len(),
					String::from_utf8_lossy(&got[got.len().saturating_sub(4)..])
				);
			},
		);
	}

	// Failure mode: two callers of one tee, each with a waker of its own (a
	// native extra's task and the engine), wait on a full FIFO through it.
	// The FIFO's readiness watch keeps one waker, and the tee polled it with
	// each caller's own, so the second caller's replaced the first's: when
	// the FIFO drained only the second woke, and the first slept on bytes
	// that went out, or that nothing moved once the second was cancelled.
	// The tee polls its targets with a waker of its own, which wakes both.
	// The FIFO takes the readiness route here, as on Linux by default.
	#[test]
	fn both_callers_waiting_on_a_tee_wake_when_its_target_drains() {
		let dir = tempfile::tempdir().unwrap();
		let (mut held, filled, p) = full_target(&dir, "p");
		let mut tee = Tee::new(vec![p]);
		let mut other = tee.dup().unwrap();
		let a = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
		let b = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
		let wa = Waker::from(Arc::clone(&a));
		let wb = Waker::from(Arc::clone(&b));
		let wrote = tee.poll_write(&mut Context::from_waker(&wa), b"a\n");
		assert!(matches!(wrote, Poll::Ready(Ok(2))), "{wrote:?}");
		assert!(
			tee.poll_settle(&mut Context::from_waker(&wa)).is_pending(),
			"A's settle on a full FIFO"
		);
		assert!(
			other
				.poll_settle(&mut Context::from_waker(&wb))
				.is_pending(),
			"B's settle on a full FIFO"
		);
		a.0.store(false, Ordering::SeqCst);
		b.0.store(false, Ordering::SeqCst);
		let drain = std::thread::spawn(move || read_up_to(&mut held, filled + 2));
		// Nothing polls B: A must be woken by the drain itself.
		let start = Instant::now();
		while !a.0.load(Ordering::SeqCst) {
			assert!(
				start.elapsed() < Duration::from_secs(5),
				"A was not woken when the FIFO drained (B woken: {})",
				b.0.load(Ordering::SeqCst)
			);
			std::thread::park_timeout(Duration::from_millis(50));
		}
		let settled = ready("A's settle", |cx| tee.poll_settle(cx));
		assert!(settled.is_ok(), "{settled:?}");
		let got = drain.join().unwrap();
		assert!(got == expected(filled, 0, b"a\n"), "the FIFO got {} bytes", got.len());
	}

	/// Fires a tee's own waker when woken: a target's wake that comes while
	/// the tee wakes its other waiters.
	struct FiresTee(Arc<Waiters>);

	impl Wake for FiresTee {
		fn wake(self: Arc<Self>) {
			Wake::wake_by_ref(&self.0);
		}
	}

	// Failure mode: a call that moved a tee's queue on woke the other
	// waiters by taking the whole list and adding its own caller back
	// after. A target's wake that came in that gap found an empty list, and
	// the caller, still waiting on that target, slept with nothing to wake
	// it. B's wake here is that target's wake: it comes while the others are
	// woken, and must find A.
	#[test]
	fn a_target_wake_while_a_tee_wakes_its_other_waiters_still_wakes_the_caller() {
		let waiters = Arc::new(Waiters::default());
		let a = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
		let wa = Waker::from(Arc::clone(&a));
		let wb = Waker::from(Arc::new(FiresTee(Arc::clone(&waiters))));
		let _ = waiters.add(&wb);
		let _ = waiters.add(&wa);
		waiters.wake_others(&wa);
		assert!(a.0.load(Ordering::SeqCst), "the target's wake in the gap did not wake the caller");
	}

	// Failure mode: A's call registered waker W and was `Ready`; before it
	// took its registration back, a target's wake took W's entry off, and
	// B's call with the same W (through a duplicate of the tee) registered
	// and waited. A's late release then took B's registration, and the next
	// target's wake found nobody to wake. A release names the generation it
	// registered under. Two calls of one waker with no wake between keep
	// one entry until both are released.
	#[test]
	fn a_late_release_never_takes_a_newer_calls_registration() {
		let waiters = Arc::new(Waiters::default());
		let waker = Waker::from(Arc::new(Woken(AtomicBool::new(false), std::thread::current())));
		let first = waiters.add(&waker);
		Wake::wake_by_ref(&waiters);
		let newer = waiters.add(&waker);
		waiters.release(first);
		assert_eq!(waiters.0.lock().entries.len(), 1, "A's late release took B's registration");
		waiters.release(newer);
		assert_eq!(waiters.0.lock().entries.len(), 0, "B's release left its entry");
		let one = waiters.add(&waker);
		let other = waiters.add(&waker);
		waiters.release(one);
		assert_eq!(waiters.0.lock().entries.len(), 1, "C's release took D's registration");
		waiters.release(other);
		assert_eq!(waiters.0.lock().entries.len(), 0, "D's release left its entry");
	}

	/// What a [`Gate`] took, and whether it takes writes now.
	#[derive(Default)]
	struct GateState {
		open:  bool,
		got:   Vec<u8>,
		waker: Option<Waker>,
	}

	/// A tee target that takes nothing until it opens, and everything after,
	/// holding the waker of the last write it refused.
	struct Gate(Arc<parking_lot::Mutex<GateState>>);

	impl Gate {
		fn closed() -> (Self, Arc<parking_lot::Mutex<GateState>>) {
			let state = Arc::new(parking_lot::Mutex::new(GateState::default()));
			(Self(Arc::clone(&state)), state)
		}
	}

	impl File for Gate {
		fn poll_read(
			&mut self,
			_cx: &mut Context<'_>,
			_buf: &mut [u8],
		) -> Poll<std::io::Result<usize>> {
			Poll::Ready(Ok(0))
		}

		fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
			let mut s = self.0.lock();
			if !s.open {
				s.waker = Some(cx.waker().clone());
				return Poll::Pending;
			}
			s.got.extend_from_slice(buf);
			Poll::Ready(Ok(buf.len()))
		}

		fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		fn seek(&mut self, _pos: SeekFrom) -> std::io::Result<u64> {
			Err(std::io::ErrorKind::Unsupported.into())
		}

		fn kind(&self) -> FileKind {
			FileKind::Pipe
		}

		fn os_handle(&self) -> Option<OsHandle> {
			None
		}

		fn dup(&self) -> std::io::Result<Box<dyn File>> {
			Ok(Box::new(Self(Arc::clone(&self.0))))
		}
	}

	/// Opens the gate and wakes the write it refused last.
	fn open(state: &parking_lot::Mutex<GateState>) {
		let waker = {
			let mut s = state.lock();
			s.open = true;
			s.waker.take()
		};
		if let Some(w) = waker {
			w.wake();
		}
	}

	/// Writes all of `buf[off..]` through `file`, waiting for wakes.
	fn write_rest(file: &mut (impl File + ?Sized), buf: &[u8], mut off: usize) {
		while off < buf.len() {
			let n = ready("a write through the tee", |cx| file.poll_write(cx, &buf[off..]))
				.expect("the tee refused a write");
			off += n;
		}
	}

	/// A line of `len` bytes of `byte`, ending in a newline.
	fn line(byte: u8, len: usize) -> Vec<u8> {
		let mut line = vec![byte; len];
		line[len - 1] = b'\n';
		line
	}

	// Failure mode: a tee split a write of at most `PIPE_BUF` bytes when
	// the queue was near `TEE_HOLD`: it took the first part of A's line and
	// returned it as written, and when B was polled before A's next call,
	// B's line was queued between A's two parts, so every target got a torn
	// line. A pipe keeps such a write whole, and so does zsh's tee, which
	// reads from one. The tee takes a write of at most `TEE_WHOLE` bytes
	// whole or not at all; a longer write still takes what fits.
	#[test]
	fn two_writers_lines_of_pipe_buf_bytes_never_interleave_in_a_tee() {
		let (gate, state) = Gate::closed();
		let mut tee = Tee::new(vec![FdRef::from_file(Box::new(gate))]);
		// The queue 100 bytes short of `TEE_HOLD`; the target takes nothing.
		let filler = vec![b'F'; TEE_HOLD - 100];
		let took = once(|cx| tee.poll_write(cx, &filler));
		assert!(matches!(took, Poll::Ready(Ok(n)) if n == filler.len()), "{took:?}");
		let a = line(b'A', TEE_WHOLE);
		let b = line(b'B', TEE_WHOLE);
		// B writes through a duplicate, as a second writer of the fd does.
		let mut dup = tee.dup().unwrap();
		let a_took = match once(|cx| tee.poll_write(cx, &a)) {
			Poll::Ready(Ok(n)) => n,
			Poll::Pending => 0,
			Poll::Ready(Err(e)) => panic!("A's write: {e}"),
		};
		let b_took = match once(|cx| dup.poll_write(cx, &b)) {
			Poll::Ready(Ok(n)) => n,
			Poll::Pending => 0,
			Poll::Ready(Err(e)) => panic!("B's write: {e}"),
		};
		// The target opens, and B is polled before A.
		open(&state);
		write_rest(&mut *dup, &b, b_took);
		write_rest(&mut tee, &a, a_took);
		let settled = ready("the tee's settle", |cx| tee.poll_settle(cx));
		assert!(settled.is_ok(), "{settled:?}");
		let got = std::mem::take(&mut state.lock().got);
		assert!(got.starts_with(&filler), "the filler did not come first");
		let rest = &got[filler.len()..];
		assert!(
			rest == [&b[..], &a[..]].concat() || rest == [&a[..], &b[..]].concat(),
			"a line was torn: A took {a_took} bytes at first, and the lines after the filler start \
			 {:?}",
			String::from_utf8_lossy(&rest[..rest.len().min(8)])
		);
		// Control: a write longer than `TEE_WHOLE` still takes what fits.
		let (gate, _state) = Gate::closed();
		let mut tee = Tee::new(vec![FdRef::from_file(Box::new(gate))]);
		let took = once(|cx| tee.poll_write(cx, &filler));
		assert!(matches!(took, Poll::Ready(Ok(n)) if n == filler.len()), "{took:?}");
		let long = line(b'L', TEE_WHOLE + 1);
		let took = once(|cx| tee.poll_write(cx, &long));
		assert!(matches!(took, Poll::Ready(Ok(100))), "a long write near TEE_HOLD: {took:?}");
	}

	// Failure mode: the engine polls every vproc with one waker. Vproc B
	// waits in the tee's settle; vproc A's write through the tee registers
	// the same waker again, and its drive finds the target ready (a host
	// file whose readiness watch was dropped before it fired) and moves the
	// queue on. The tee woke every waiter but A's waker, which is B's too,
	// so B stayed parked until an unrelated wake. With another call
	// registered under the caller's waker, the tee wakes that waker as well.
	#[test]
	fn a_call_that_moves_a_tee_wakes_another_call_sharing_its_waker() {
		let (gate, state) = Gate::closed();
		let mut tee = Tee::new(vec![FdRef::from_file(Box::new(gate))]);
		let engine = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
		let waker = Waker::from(Arc::clone(&engine));
		let mut cx = Context::from_waker(&waker);
		// B writes and waits in its settle.
		assert!(matches!(tee.poll_write(&mut cx, b"b\n"), Poll::Ready(Ok(2))));
		assert!(tee.poll_settle(&mut cx).is_pending(), "B's settle with the target closed");
		// The target becomes ready without a wake.
		state.lock().open = true;
		engine.0.store(false, Ordering::SeqCst);
		// A's write, with the engine's one waker, moves the queue on.
		assert!(matches!(tee.poll_write(&mut cx, b"a\n"), Poll::Ready(Ok(2))));
		assert!(
			engine.0.load(Ordering::SeqCst),
			"B waits in the tee under the engine's waker and was not woken"
		);
		assert!(tee.poll_settle(&mut cx).is_ready(), "B's settle after the wake");
		assert_eq!(std::mem::take(&mut state.lock().got), b"b\na\n");
		// Control: a call alone under its waker is not woken by its own move.
		let (gate, state) = Gate::closed();
		let mut tee = Tee::new(vec![FdRef::from_file(Box::new(gate))]);
		let alone = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
		let waker = Waker::from(Arc::clone(&alone));
		let mut cx = Context::from_waker(&waker);
		assert!(matches!(tee.poll_write(&mut cx, b"c\n"), Poll::Ready(Ok(2))));
		state.lock().open = true;
		assert!(tee.poll_settle(&mut cx).is_ready(), "the settle with the target open");
		assert!(!alone.0.load(Ordering::SeqCst), "a call alone under its waker woke itself");
	}

	// Failure mode: a registration whose call is gone kept its count. A
	// settle under the engine's waker waited and was never polled again
	// (cancelled), and the target became ready with no wake, so no target's
	// wake took the entry off. From then on every write under that waker
	// that moved the queue saw a count above 1 and woke the engine, which
	// made every parked vproc runnable, on each `echo` through the tee. The
	// first move wakes the engine once, for the call registered under its
	// waker, and puts the count back to the caller's own one: later moves
	// by a caller alone under its waker do not wake it.
	#[test]
	fn a_gone_calls_registration_wakes_the_caller_once_not_on_every_move() {
		let (gate, state) = Gate::closed();
		let mut tee = Tee::new(vec![FdRef::from_file(Box::new(gate))]);
		let engine = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
		let waker = Waker::from(Arc::clone(&engine));
		let mut cx = Context::from_waker(&waker);
		assert!(matches!(tee.poll_write(&mut cx, b"b\n"), Poll::Ready(Ok(2))));
		// A settle that waits and is never polled again.
		assert!(tee.poll_settle(&mut cx).is_pending(), "the settle with the target closed");
		// The target becomes ready without a wake.
		state.lock().open = true;
		engine.0.store(false, Ordering::SeqCst);
		assert!(matches!(tee.poll_write(&mut cx, b"a\n"), Poll::Ready(Ok(2))));
		assert!(engine.0.load(Ordering::SeqCst), "the first move did not wake the waiting call");
		for i in 1..=3 {
			engine.0.store(false, Ordering::SeqCst);
			assert!(matches!(tee.poll_write(&mut cx, b"c\n"), Poll::Ready(Ok(2))));
			assert!(
				!engine.0.load(Ordering::SeqCst),
				"move {i} woke the engine for the registration of a call that is gone"
			);
		}
		assert_eq!(waiting(&tee), 0, "the tee keeps a waker after every call finished");
		assert_eq!(std::mem::take(&mut state.lock().got), b"b\na\nc\nc\nc\n");
	}

	/// How many wakers a tee holds.
	fn waiting(tee: &Tee) -> usize {
		tee.0.waiters.0.lock().entries.len()
	}

	// Failure mode: every call left its caller's waker with the tee, so
	// tasks that settled or flushed an idle tee, each with a waker of its
	// own, grew the tee's list for as long as nothing moved. A call that is
	// `Ready` takes its registration back; one that waited and was dropped
	// is taken off by the next wake.
	#[test]
	fn a_tee_keeps_the_wakers_of_waiting_calls_only() {
		let null = host(
			std::fs::OpenOptions::new()
				.write(true)
				.open("/dev/null")
				.unwrap(),
		);
		let mut idle = Tee::new(vec![null]);
		for _ in 0..100 {
			let woken = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
			let waker = Waker::from(woken);
			let mut cx = Context::from_waker(&waker);
			assert!(idle.poll_settle(&mut cx).is_ready());
			assert!(idle.poll_flush(&mut cx).is_ready());
		}
		assert_eq!(waiting(&idle), 0, "the wakers of 100 finished calls on an idle tee");
		// A call that waits, then is dropped.
		let dir = tempfile::tempdir().unwrap();
		let (mut held, filled, p) = full_target(&dir, "p");
		let mut tee = Tee::new(vec![p]);
		let c = Arc::new(Woken(AtomicBool::new(false), std::thread::current()));
		let wc = Waker::from(Arc::clone(&c));
		let wrote = tee.poll_write(&mut Context::from_waker(&wc), b"c\n");
		assert!(matches!(wrote, Poll::Ready(Ok(2))), "{wrote:?}");
		assert!(
			tee.poll_settle(&mut Context::from_waker(&wc)).is_pending(),
			"C's settle on a full FIFO"
		);
		assert_eq!(waiting(&tee), 1, "C waits");
		c.0.store(false, Ordering::SeqCst);
		let drain = std::thread::spawn(move || read_up_to(&mut held, filled + 2));
		let start = Instant::now();
		while !c.0.load(Ordering::SeqCst) {
			assert!(start.elapsed() < Duration::from_secs(5), "C was not woken when the FIFO drained");
			std::thread::park_timeout(Duration::from_millis(50));
		}
		// C is not polled again; the wake took it off.
		assert_eq!(waiting(&tee), 0, "the waker of a call dropped while it waited");
		let settled = ready("the tee's settle", |cx| tee.poll_settle(cx));
		assert!(settled.is_ok(), "{settled:?}");
		assert_eq!(waiting(&tee), 0, "the waker of a finished settle");
		let got = drain.join().unwrap();
		assert!(got == expected(filled, 0, b"c\n"), "the FIFO got {} bytes", got.len());
	}

	// Failure mode: a writer through `FdRef::poll_write_out` (zsh's
	// `syswrite` and `sysread -o`, a job notice, the zle display) counted
	// the bytes a tee had only queued as written: the tee gave its writes no
	// mark, so nothing waited for its targets, and a tee closed next dropped
	// what its queue held. A tee's write now has a mark, done once every
	// target has the write.
	#[test]
	fn a_write_out_through_a_tee_is_done_only_once_every_target_has_it() {
		let (gate, state) = Gate::closed();
		let tee = FdRef::from_file(Box::new(Tee::new(vec![FdRef::from_file(Box::new(gate))])));
		let mut unsettled = crate::bash::Unsettled::default();
		let bytes = vec![b'A'; 100];
		let wrote = once(|cx| tee.poll_write_out(cx, &bytes, &mut unsettled));
		assert!(wrote.is_pending(), "done with the target holding none of it: {wrote:?}");
		open(&state);
		let wrote = ready("the write once the target opened", |cx| {
			tee.poll_write_out(cx, &bytes, &mut unsettled)
		});
		assert_eq!(wrote.ok(), Some(100));
		assert_eq!(state.lock().got, bytes, "the target's bytes");
	}

	/// What a [`Held`] target took, and the marks of its chunks.
	#[derive(Default)]
	struct HeldState {
		got:   Vec<u8>,
		marks: Vec<Mark>,
		waker: Option<Waker>,
	}

	/// A tee target that takes every write at once into its writer thread's
	/// hand, as a host file does, and writes it out only when the test says
	/// so ([`write_out`]): its chunks' marks stay not done until then.
	struct Held(Arc<parking_lot::Mutex<HeldState>>);

	impl File for Held {
		fn poll_read(
			&mut self,
			_cx: &mut Context<'_>,
			_buf: &mut [u8],
		) -> Poll<std::io::Result<usize>> {
			Poll::Ready(Ok(0))
		}

		fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
			self.poll_write_marked(cx, buf).map_ok(|(n, _)| n)
		}

		fn poll_write_marked(
			&mut self,
			_cx: &mut Context<'_>,
			buf: &[u8],
		) -> Poll<std::io::Result<(usize, Option<Mark>)>> {
			let mark = Mark::new();
			let mut s = self.0.lock();
			s.got.extend_from_slice(buf);
			s.marks.push(mark.clone());
			Poll::Ready(Ok((buf.len(), Some(mark))))
		}

		fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
			Poll::Ready(Ok(()))
		}

		fn poll_settle(&mut self, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
			let marks = self.0.lock().marks.clone();
			self.poll_settle_marked(cx, &marks)
		}

		fn poll_settle_marked(
			&mut self,
			cx: &mut Context<'_>,
			marks: &[Mark],
		) -> Poll<std::io::Result<()>> {
			if marks.iter().all(Mark::is_done) {
				return Poll::Ready(marks.iter().try_for_each(Mark::take_error));
			}
			self.0.lock().waker = Some(cx.waker().clone());
			Poll::Pending
		}

		fn seek(&mut self, _pos: SeekFrom) -> std::io::Result<u64> {
			Err(std::io::ErrorKind::Unsupported.into())
		}

		fn kind(&self) -> FileKind {
			FileKind::Pipe
		}

		fn os_handle(&self) -> Option<OsHandle> {
			None
		}

		fn dup(&self) -> std::io::Result<Box<dyn File>> {
			Ok(Box::new(Self(Arc::clone(&self.0))))
		}
	}

	/// The [`Held`] target's writer thread writes out every chunk it holds.
	fn write_out(state: &parking_lot::Mutex<HeldState>) {
		let waker = {
			let mut s = state.lock();
			for mark in &s.marks {
				mark.finish(Ok(()));
			}
			s.waker.take()
		};
		if let Some(w) = waker {
			w.wake();
		}
	}

	// Failure mode: a tee's write counted as done while a target had taken
	// the chunk into its writer thread's hand and not written it out (the
	// tee moved that target on without settling the chunk), or once one
	// target, not every one, had the write. Of two targets, one writes as
	// it takes and the other holds what it took: the write is done only
	// once the second has written its chunk out.
	#[test]
	fn a_tee_write_is_done_only_once_a_target_holding_it_has_written_it_out() {
		let (writes, wrote) = Gate::closed();
		open(&wrote);
		let held = Arc::new(parking_lot::Mutex::new(HeldState::default()));
		let mut tee = Tee::new(vec![
			FdRef::from_file(Box::new(writes)),
			FdRef::from_file(Box::new(Held(Arc::clone(&held)))),
		]);
		let bytes = vec![b'A'; 100];
		let took = once(|cx| tee.poll_write_marked(cx, &bytes));
		let Poll::Ready(Ok((100, Some(mark)))) = took else {
			panic!("the tee took {took:?}");
		};
		for _ in 0..3 {
			let settled = once(|cx| tee.poll_settle_marked(cx, std::slice::from_ref(&mark)));
			assert!(settled.is_pending(), "settled with the second target's chunk in its hand");
		}
		assert_eq!(wrote.lock().got, bytes, "the first target wrote the write");
		assert_eq!(held.lock().got, bytes, "the second target took the write into its hand");
		assert!(
			!mark.is_done(),
			"the write was done while the second target had not written its chunk out"
		);
		write_out(&held);
		let settled = ready("the write once the second target wrote its chunk out", |cx| {
			tee.poll_settle_marked(cx, std::slice::from_ref(&mark))
		});
		assert!(settled.is_ok(), "{settled:?}");
		assert_eq!(held.lock().got, bytes, "the second target's bytes, once");
	}
}
