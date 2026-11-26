//! Virtual processes, scripts, frames and per-op scratch.

use std::{collections::VecDeque, sync::Arc};

use bstr::BString;
use serde::{Deserialize, Serialize};

use super::state::{Level, Random, Scope, Var};
pub use crate::bash::store::{Job, JobProc, JobProcs, JobState, ProcState};
use crate::bash::{
	Image,
	event::{OriginChain, ResolvedKind, WaitKey},
	fd::{FdRef, FdTable},
	fs::{FsPending, Stat},
	host::{ExtProc, Resolved, Task},
	ids::{CallId, CmdTag, IntrinsicId, JobId, ModeId, NativeRef, RunId, ToolRef, Vpid},
	ir::Unit,
	mem::Capture,
	signal::{SigSet, Signal},
	syntax::Pos,
};

/// A green thread: its scripts, frames, fds, cwd and global state.
pub struct Vproc {
	pub vpid:          Vpid,
	pub parent:        Option<Vpid>,
	/// Scripts queued on this vproc (root only); the front one runs.
	pub runs:          VecDeque<Run>,
	/// Activation stack.
	pub frames:        Vec<Frame>,
	/// Function-local scopes, innermost last.
	pub scopes:        Vec<Scope>,
	pub fds:           FdTable,
	pub cwd:           BString,
	/// `$?`.
	pub status:        i32,
	/// `PIPESTATUS` of the last pipeline.
	pub pipestatus:    Vec<i32>,
	/// A forked vproc's global state: its parent's at the fork, then its
	/// own writes (copy-on-write; see `state`). `None` for the root vproc,
	/// whose global state is the store.
	pub image:         Option<Image>,
	/// A forked vproc's locale-variable count (`state::locale_token`): the
	/// root's at the fork, `None` once it assigned a locale variable.
	pub locale_gen:    Option<u64>,
	/// Diagnostics waiting to be written to their fds.
	pub out:           VecDeque<PendingWrite>,
	pub blocked:       Option<Blocked>,
	/// Signal traps deferred until the foreground command completes.
	pub pending_traps: SigSet,
	/// Stopped by a virtual `STOP` (job control).
	pub stopped:       bool,
	/// Exit once its frames are done (subshell vprocs).
	pub transient:     bool,
	/// Set when this vproc's EXIT trap has been started. A root vproc keeps
	/// the same flag per run ([`Run::exit_trap_started`]); a forked subshell
	/// has no `Run`, and its `own_traps`, `trap_frames` and the frame scans
	/// all go back to their pre-trap values once the trap's frame is popped,
	/// so without this the trap could start a second time.
	pub exit_trap_run: bool,
	/// Background jobs not yet waited for or reported, current/previous
	/// job and the `SIGCHLD` trap runs owed.
	pub jobs:          JobTable,
	/// `$!`: the last asynchronous child and the OS pid it is known by.
	pub last_bg:       LastBg,
	/// Cleared scratches kept for the next ops (allocation reuse), at most
	/// one per nesting level a caller's op parks at (a function call keeps
	/// its op's scratch while the body needs another); never serialized.
	#[expect(
		clippy::vec_box,
		reason = "the boxes move between frames (`Frame::scratch`) and this pool without copying"
	)]
	pub spare:         Vec<Box<Scratch>>,
	/// Host lineage, inherited from the parent (set by
	/// [`super::ShellApi::run_subshell_in`]) and passed to externals.
	pub lineage:       crate::bash::host::Lineage,
	/// `set -x` nesting this vproc starts at, beyond the first level (bash's
	/// `indirection_level`): its parent's, plus one in a command
	/// substitution.
	pub trace_base:    u32,
	/// `$BASH_SUBSHELL`: the subshell nesting (0 for the shell itself and a
	/// nested shell) in its low 24 bits ([`super::subshell_depth`]), and the
	/// vproc's [`Fork`] in its top byte ([`Vproc::fork`]). A field, not an
	/// image record: a record would cost every subshell a ~530-byte map
	/// allocation (idle vproc ≤ 2 KiB, which leaves no byte for a field of
	/// its own).
	pub subshell:      u32,
	/// Loops of the shell that forked this vproc that its code runs inside
	/// (bash's inherited `loop_level`, zsh's `loops`), set by
	/// [`super::exec::fork_loops`]: a `break` or `continue` that reaches
	/// past this vproc's own loops ends the vproc, as the end of its code
	/// would. Zero for the shell itself and for a fork bash runs through
	/// `execute_in_subshell`, which zeroes the level. A `u16` (saturating
	/// past 65,535 loops) that shares `trap_frames`'s former 4 bytes, so
	/// `Vproc` keeps its size.
	pub outer_loops:   u16,
	/// The command being run (`BASH_COMMAND`): its unit and syntax node.
	/// Externalized by unit id (a trap action continuing after a restore
	/// still names the trapped command).
	pub command:       Option<(Arc<Unit>, u32)>,
	/// Pushes onto bash's call-stack arrays (`FUNCNAME`, `BASH_SOURCE`,
	/// `BASH_LINENO`, `BASH_ARGC`, `BASH_ARGV`), oldest first; a subshell
	/// starts with its parent's.
	pub calls:         Vec<super::callstack::Call>,
	/// The traps this vproc set itself: a subshell lists its parent's but
	/// runs only its own (ERR, DEBUG and RETURN also under
	/// `errtrace`/`functrace`; bash 5.3 keeps listing inherited signal
	/// traps until the subshell changes one).
	pub own_traps:     OwnTraps,
	/// bash: the signals this vproc ignores as an asynchronous command
	/// without job control (`INT`, `QUIT`; bash 5.3 `setup_async_signals`,
	/// `set_signal_async_ignored`), and whether it acts on an ignored `INT`
	/// itself all the same (a fork of a vproc that named `INT` in `trap`).
	/// Set by `exec::ignore_async_signals`, read by `exec::async_ignored`;
	/// its forks inherit it (`exec::fork_async_ignored`). A field, not an
	/// overlay record: a record would cost every asynchronous vproc a
	/// ~530-byte map allocation (idle vproc ≤ 2 KiB).
	pub async_ignored: AsyncIgnored,
	/// Trap-action frames ([`ScriptKind::Trap`]) on `frames`: zero lets
	/// the per-op checks (cancellation, `BASH_COMMAND`, a trap inside its
	/// own action) skip their frame scans. Kept by
	/// [`super::exec::push_script`], [`super::exec::pop_frame`] and the
	/// frame restore; never serialized (recounted from the frames). A trap
	/// never runs inside its own action, so they nest at most once per trap
	/// kind, far below `u16::MAX`.
	pub trap_frames:   u16,
	/// A `break` or `continue` run inside `${ }` or `${| }` that no loop
	/// has taken yet (bash's `breaking` or `continuing`); boxed, as it is
	/// rare and an idle vproc pays 8 B for it.
	pub pending_break: Option<Box<PendingBreak>>,
	/// Current mode: the emulation its code runs under, set by
	/// `emulate`, a mode-switching function call (restored on return) and
	/// a run's explicit mode; inherited by children. The root's is written
	/// through as `MiscKey::Mode`. Every event reports it.
	pub mode:          ModeId,
	/// zsh state of a vproc running zsh or mode-switching code (`None` for
	/// pure bash: nothing to keep, nothing to check).
	pub zsh:           Option<Box<VprocZsh>>,
	/// The line editor's state ([`super::zle::Zle`]): keymaps, widgets,
	/// kill ring and the line being edited; created when ZLE is first used.
	/// Inherited (copied) by children; never serialized: a restored shell
	/// starts with zsh's defaults and no line in progress.
	pub zle:           Option<Box<super::zle::Zle>>,
	/// A forked vproc's `$RANDOM` generator and `$SECONDS` origin
	/// ([`Clock`]): its parent's at the fork. `None` for the root vproc,
	/// whose are the kernel's.
	pub clock:         Option<Clock>,
	/// State most vprocs never use ([`VprocRare`]): `None` until one of it
	/// is set. Read through [`Vproc::rare`], written through
	/// [`Vproc::rare_mut`].
	pub rare:          Option<Box<VprocRare>>,
}

/// What `ulimit` set ([`VprocRare::rlimits`]): a resource with its soft and
/// hard limits (`None`: unlimited).
pub type Rlimits = Vec<(crate::bash::host::Rlimit, Option<u64>, Option<u64>)>;

/// A vproc's state that most vprocs never use: `getopts` progress, process
/// substitutions, coprocesses, `local -` saves and `ulimit` values
/// ([`Vproc::rare`]). Boxed, so an idle vproc pays one pointer for it in
/// place of 144 B. New state that most vprocs leave empty goes here, not in
/// `Vproc`: a held `local IFS` split value or a job list's kept record, for
/// instance, each 8 B of every idle vproc as a field of its own.
#[derive(Clone, Debug, Default)]
pub struct VprocRare {
	/// `getopts` progress between calls.
	pub getopts:      GetoptsState,
	/// Open process-substitution fds: `(frame depth, fd)`, the depth being
	/// the frame count when the op that opened it ran.
	pub procsubs:     Vec<(u32, i32)>,
	/// Coprocesses not reaped yet.
	pub coprocs:      Vec<Coproc>,
	/// `set -o` states saved by `local -` in functions that returned, to
	/// restore before the next op.
	pub restore_opts: Vec<BString>,
	/// Limits `ulimit` set in this vproc or inherited from its parent;
	/// passed to externals, never applied to the host process.
	pub rlimits:      Rlimits,
}

/// [`Vproc::rare`] of a vproc that has none.
static NO_RARE: VprocRare = VprocRare {
	getopts:      GetoptsState::NONE,
	procsubs:     Vec::new(),
	coprocs:      Vec::new(),
	restore_opts: Vec::new(),
	rlimits:      Vec::new(),
};

impl Vproc {
	/// The state most vprocs never use ([`VprocRare`]); all empty when the
	/// vproc has none.
	pub fn rare(&self) -> &VprocRare {
		self.rare.as_deref().unwrap_or(&NO_RARE)
	}

	/// The same, to write: made (empty) on first use.
	pub fn rare_mut(&mut self) -> &mut VprocRare {
		self.rare.get_or_insert_with(Box::default)
	}

	/// `getopts` progress between calls ([`VprocRare::getopts`]).
	pub fn getopts(&self) -> &GetoptsState {
		&self.rare().getopts
	}

	/// Open process-substitution fds ([`VprocRare::procsubs`]).
	pub fn procsubs(&self) -> &[(u32, i32)] {
		&self.rare().procsubs
	}

	/// Coprocesses not reaped yet ([`VprocRare::coprocs`]).
	pub fn coprocs(&self) -> &[Coproc] {
		&self.rare().coprocs
	}

	/// The `ulimit` values externals get ([`VprocRare::rlimits`]).
	pub fn rlimits(&self) -> &[(crate::bash::host::Rlimit, Option<u64>, Option<u64>)] {
		&self.rare().rlimits
	}

	/// Sets the `getopts` progress; a vproc without rare state keeps none
	/// for the empty progress.
	pub fn set_getopts(&mut self, getopts: GetoptsState) {
		if self.rare.is_some() || getopts != GetoptsState::NONE {
			self.rare_mut().getopts = getopts;
		}
	}

	/// Sets the `ulimit` values; a vproc without rare state keeps none for
	/// no values.
	pub fn set_rlimits(&mut self, rlimits: Rlimits) {
		if self.rare.is_some() || !rlimits.is_empty() {
			self.rare_mut().rlimits = rlimits;
		}
	}
}

/// A forked vproc's `$RANDOM` generator and `$SECONDS` clock
/// ([`Vproc::clock`]). Both are process state that a fork copies, as
/// `fork(2)` copies memory, so neither side's draws, `RANDOM=` or
/// `SECONDS=` reach the other. The shell's own are the kernel's
/// (`Kernel::rand`, `Kernel::start_ns`, `Kernel::seconds`), which the store
/// keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Clock {
	pub rand:          Random,
	/// The generator is reseeded on the vproc's first `$RANDOM` in bash code
	/// unless `RANDOM` was assigned first, as bash reseeds a subshell's
	/// (`get_random_number`'s `seeded_subshell`); zsh draws on from the copy.
	pub reseed:        bool,
	/// The host clock reading of the shell's start, or of the last
	/// `SECONDS=` in bash code (bash's `shellstart`, which `assign_seconds`
	/// resets to now): `printf '%(…)T' -2` and the shell's `time` report
	/// count from it.
	pub start_ns:      u64,
	/// The value of the last `SECONDS=` in bash code (bash's
	/// `seconds_value_assigned`): `$SECONDS` is it plus the seconds since
	/// `start_ns`. zsh's `SECONDS=` moves `start_ns` instead and sets it to 0.
	pub seconds:       i64,
	/// `unset SECONDS` or an array assignment in bash code removed the
	/// special meaning of `SECONDS`: a plain variable from then on (bash
	/// removes the dynamic variable).
	pub seconds_plain: bool,
	/// The same for `RANDOM`.
	pub random_plain:  bool,
	/// `unset` in bash code removed these value cells (bits of
	/// `dynvars::CELLS` indices): plain variables from then on (bash removes
	/// the dynamic variable).
	pub cells_plain:   u16,
}

/// A `break` or `continue` that ran inside `${ }` or `${| }`
/// ([`Vproc::pending_break`]). bash's `break` only sets `breaking`: the
/// substitution's body ends there, later substitutions of its command run
/// nothing, the command itself runs, and the next loop out takes the
/// levels left ([`super::exec`]'s `pending_break`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingBreak {
	/// Loop levels left.
	pub levels: u32,
	/// `continue` instead of `break`.
	pub cont:   bool,
	/// The frame count of the command holding the substitution. A deeper
	/// frame is one that command entered: its `$(< file)` frame runs on;
	/// a function, `eval` or `.` runs none of its commands.
	pub depth:  u32,
	/// The frame count of the command whose redirections were being expanded
	/// when the `break` ran (0: not in a redirection). bash expands the
	/// redirections of a program it runs (an external, a command it cannot
	/// find) in the forked child, so the break is lost with that child: it is
	/// dropped once that command's name resolves to one ([`super::command`]'s
	/// `drop_childs_break`).
	pub redir:  u32,
}

/// `extdebug`: the stages of the `Spawn` at frame `frame` of vproc `vproc`
/// whose DEBUG trap, run in the shell before the fork, failed (their
/// entries): bash forks no process for such a stage. Moved to the job's
/// vproc when the pipeline is a background job's. Kept by the kernel
/// ([`super::Kernel::debug_skips`]), not the vproc or frame (each at its
/// idle-size bound), and only while a skip waits for its `Spawn`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DebugSkip {
	pub vproc:   Vpid,
	pub frame:   u32,
	pub entries: Vec<u32>,
}

/// What a vproc's fatal expansion errors reach, whether bash forked it to
/// run one command, and whether that command's own redirections ended it
/// ([`Vproc::fork`]), kept in the top byte of [`Vproc::subshell`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fork(u8);

impl Fork {
	/// A subshell catcher (bash's `execute_in_subshell`, a command
	/// substitution's) lies between it and the run's top level.
	const CAUGHT: u8 = 1;
	/// A subshell, a command substitution, a compound job: bash's
	/// `execute_in_subshell` (or the substitution's own catcher) catches its
	/// fatal errors, which exit with the failure status.
	pub const CHILD: Self = Self(Self::CAUGHT);
	/// The one command's own redirections (below) met a fatal error: the
	/// fork exits once their message is written ([`Self::ending`]).
	const ENDING: u8 = 4;
	/// The one command it was forked for has its own redirections to come.
	const ENTRY: u8 = 2;
	/// The shell itself, or a nested shell: bash's `run_one_command` catches
	/// its fatal errors (a `-c` string exits 127).
	pub const SHELL: Self = Self(0);

	/// A fork made to run one command (an async command, a pipeline
	/// stage), bash's fork before it: that command's own redirections are
	/// made without undo (`RX_UNDOABLE` unset), and a fatal error in them,
	/// or anywhere in a simple command, reaches what `parent`'s reach.
	pub const fn entry(parent: Self) -> Self {
		Self((parent.0 & Self::CAUGHT) | Self::ENTRY)
	}

	/// A fatal expansion error here reaches the run's top level.
	pub const fn catches(self) -> bool {
		self.0 & Self::CAUGHT == 0
	}

	/// Forked to run one command whose own redirections are still to come:
	/// the command at the vproc's base frame is that command.
	pub const fn at_entry(self) -> bool {
		self.0 & Self::ENTRY != 0
	}

	/// The fork whose own redirections met a fatal error: it exits, with
	/// `$?`, once their message is written (the op that made them waits for
	/// a full stream, and when it comes back it exits instead of making them
	/// again).
	pub const fn end(self) -> Self {
		Self(self.0 | Self::ENDING)
	}

	/// [`Self::end`]: the fork only waits to exit.
	pub const fn ending(self) -> bool {
		self.0 & Self::ENDING != 0
	}
}

/// The bits of [`Vproc::subshell`] that hold the depth.
pub(super) const SUBSHELL_DEPTH: u32 = 0x00ff_ffff;

impl Vproc {
	/// What this vproc's fatal expansion errors reach, whether it was forked
	/// to run one command whose own redirections are still to come, and
	/// whether they ended it.
	pub const fn fork(&self) -> Fork {
		Fork((self.subshell >> 24) as u8)
	}

	/// Set [`Self::fork`].
	pub const fn set_fork(&mut self, fork: Fork) {
		self.subshell = (self.subshell & SUBSHELL_DEPTH) | ((fork.0 as u32) << 24);
	}
}

/// The terminal of the session a vproc runs in when it is not the shell's
/// ([`VprocZsh::ctty`]).
#[derive(Clone, Debug, Default)]
pub struct Ctty(pub Option<FdRef>);

impl PartialEq for Ctty {
	fn eq(&self, other: &Self) -> bool {
		match (&self.0, &other.0) {
			(Some(a), Some(b)) => a.same(b),
			(None, None) => true,
			_ => false,
		}
	}
}

impl Eq for Ctty {}

/// A vproc's zsh state ([`Vproc::zsh`]).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VprocZsh {
	/// zsh's current sticky emulation (zsh's global `sticky`): set while
	/// `emulate MODE -c` runs and inside a sticky function; a function
	/// defined meanwhile records it.
	pub sticky:             Option<crate::bash::store::Sticky>,
	/// What frames restore when they end: `(frame count with the frame on
	/// top, saved state)` for the `eval` frame of `emulate … -c` (zsh
	/// `bin_emulate`) and a trap running in another mode; innermost last.
	pub restores:           Vec<(u32, crate::bash::store::ZshScope)>,
	/// zsh `exit_pending`: `exit N` ran inside a function: `(N, the call
	/// depth then)` (zsh `exit_val`, `exit_level`). The functions return one
	/// by one down from that depth (their `always` lists and `EXIT` traps
	/// run; a call those lists make runs to its end), then the shell exits
	/// with N.
	pub exit_pending:       Option<(i32, u32)>,
	/// The diagnostic site a subshell of zsh code inherits (zsh forks keep
	/// `scriptname`): its parent's script name and the script line its
	/// lines count from (a function's definition line); used when none of
	/// its own frames names a site (`Kernel::zsh_site`).
	pub site:               Option<(BString, u32)>,
	/// The `zsh_eval_context` a subshell of zsh code starts with: its
	/// parent's when it started (zsh forks keep the context stack); empty
	/// for none.
	pub context:            Vec<BString>,
	/// The `zsh_eval_context` word of a subshell's first frame when it is
	/// not a command substitution's (`zpty`, whose command zsh runs with
	/// `execode(…, "zpty")`).
	pub first_context:      Option<BString>,
	/// zsh/zpty's commands (zsh `ptycmds`); a subshell starts with a copy,
	/// as a zsh fork keeps the table.
	pub ptys:               crate::bash::vm::builtins::zsh_mod_zpty::PtyTable,
	/// The terminal of the session this vproc runs in (zsh's `SHTTY` of a
	/// zpty child): the slave of the `zpty` that started it (or an
	/// ancestor). Inherited by children, opened for `/dev/tty`, handed to
	/// every external it spawns ([`crate::bash::SpawnSpec::ctty`]). Never
	/// serialized: a pty is a host object, lost on restore like the host fds.
	#[serde(skip)]
	pub ctty:               Ctty,
	/// zsh/curses' state (ncurses' screen and zsh's window table) once
	/// `zcurses init` ran; a subshell starts with a copy, as a zsh fork has
	/// its own.
	pub curses:             Option<Box<crate::bash::vm::builtins::zsh_mod_curses::screen::Curses>>,
	/// zsh `zexit`'s hooks under way or done ([`crate::bash::vm::zsh::zexit`]).
	/// A subshell starts without.
	#[serde(default)]
	pub zexit:              Option<crate::bash::vm::zsh::zexit::ZExit>,
	/// The shell is exiting because of an `exit` inside a function (zsh's
	/// `exit_pending` when `zexit` runs; the engine clears
	/// [`Self::exit_pending`] once the functions have returned).
	#[serde(default)]
	pub exit_from_function: bool,
	/// zsh's `lastmathval`: the value of the last arithmetic evaluation,
	/// which a user math function returns (zsh `callmathfunc`).
	#[serde(default)]
	pub last_math:          Option<LastMath>,
	/// Files of `=(…)` substitutions: `(frame depth, path)` as
	/// [`Vproc::procsubs`]; removed when the command is over (zsh's job
	/// `filelist`). A subshell starts without.
	#[serde(default)]
	pub tempfiles:          Vec<(u32, BString)>,
	/// The code (and line) of a glob's shell-code qualifier to run above
	/// the op that returned [`Flow::Call`](super::exec::Flow::Call) for it
	/// (zsh `qualsheval`); pushed by the run loop, which drops it when the
	/// op returned anything else. Never imaged: it lives within one op step.
	#[serde(skip)]
	pub glob_hook:          Option<(BString, u32)>,
	/// A `( … )` the root runs in place of itself, as the last command of
	/// its `-c` string (zsh's `last1`: no fork). Its own last command runs
	/// in place of it in turn ([`super::killed::in_place`]). A subshell of
	/// it starts without.
	#[serde(default)]
	pub in_place:           bool,
	/// The signal (its number) the command this vproc ran in place of
	/// itself died of: an [`Self::in_place`] subshell's process would have
	/// been that command, so its parent dies of it too.
	#[serde(default)]
	pub died_of:            Option<i32>,
	/// The background jobs whose end owes a run of the `CHLD` trap, oldest
	/// first ([`super::owe_chld`]): each run takes the first as its own.
	#[serde(default)]
	pub chld_jobs:          VecDeque<Vpid>,
	/// The job whose end runs the `CHLD` trap now. zsh 5.9 adds its status
	/// to the background statuses only once the trap is over: while it runs,
	/// `wait` takes that job for no child of the shell (another finished
	/// job is one).
	#[serde(default)]
	pub chld_own:           Option<Vpid>,
}

/// A number as zsh's `lastmathval` keeps it ([`VprocZsh::last_math`]); a
/// float by its bits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LastMath {
	/// An integer.
	Int(i64),
	/// A double, `f64::to_bits`.
	Float(u64),
}

impl VprocZsh {
	/// Whether it holds nothing (the vproc drops it).
	const fn is_empty(&self) -> bool {
		self.sticky.is_none()
			&& self.restores.is_empty()
			&& self.exit_pending.is_none()
			&& self.site.is_none()
			&& self.context.is_empty()
			&& self.first_context.is_none()
			&& self.tempfiles.is_empty()
			&& self.ptys.is_empty()
			&& self.ctty.0.is_none()
			&& self.curses.is_none()
			&& self.zexit.is_none()
			&& !self.exit_from_function
			&& self.last_math.is_none()
			&& self.glob_hook.is_none()
			&& !self.in_place
			&& self.died_of.is_none()
	}
}

impl Vproc {
	/// zsh: a `( … )` the root runs in place of itself
	/// ([`VprocZsh::in_place`]).
	pub fn in_place(&self) -> bool {
		self.zsh.as_ref().is_some_and(|z| z.in_place)
	}

	/// The signal the command this vproc ran in place of itself died of
	/// ([`VprocZsh::died_of`]).
	pub fn died_of(&self) -> Option<i32> {
		self.zsh.as_ref().and_then(|z| z.died_of)
	}

	/// The vproc's zsh state, created on first use.
	pub fn zsh_state(&mut self) -> &mut VprocZsh {
		self.zsh.get_or_insert_with(Box::default)
	}

	/// zsh's current sticky emulation.
	pub fn sticky(&self) -> Option<&crate::bash::store::Sticky> {
		self.zsh.as_ref().and_then(|z| z.sticky.as_ref())
	}

	/// Set (or clear) the current sticky emulation.
	pub fn set_sticky(&mut self, sticky: Option<crate::bash::store::Sticky>) {
		match (&mut self.zsh, sticky) {
			(Some(z), s) => z.sticky = s,
			(None, Some(s)) => {
				self.zsh = Some(Box::new(VprocZsh { sticky: Some(s), ..VprocZsh::default() }));
			},
			(None, None) => {},
		}
		self.trim_zsh();
	}

	/// Keep `saved` for the frame now on top, restored when it pops.
	pub fn push_restore(&mut self, saved: crate::bash::store::ZshScope) {
		let depth = u32::try_from(self.frames.len()).unwrap_or(u32::MAX);
		self
			.zsh
			.get_or_insert_with(Box::default)
			.restores
			.push((depth, saved));
	}

	/// The state the frame popped at `depth` (the frame count with it on
	/// top) restores, if any.
	pub fn take_restore(&mut self, depth: u32) -> Option<crate::bash::store::ZshScope> {
		let z = self.zsh.as_mut()?;
		let saved = match z.restores.last() {
			Some((d, _)) if *d == depth => z.restores.pop().map(|(_, s)| s),
			_ => None,
		};
		self.trim_zsh();
		saved
	}

	/// Drop the side table once it holds nothing.
	pub(super) fn trim_zsh(&mut self) {
		if self.zsh.as_deref().is_some_and(VprocZsh::is_empty) {
			self.zsh = None;
		}
	}
}

/// A set of trap keys ([`Vproc::own_traps`]): the pseudo-signals and the
/// signals.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnTraps {
	pseudo:  u8,
	signals: SigSet,
}

impl OwnTraps {
	/// The empty set.
	pub const EMPTY: Self = Self { pseudo: 0, signals: SigSet::EMPTY };

	const fn bit(key: crate::bash::store::TrapKey) -> u8 {
		use crate::bash::store::TrapKey;
		match key {
			TrapKey::Exit => 1,
			TrapKey::Err => 2,
			TrapKey::Debug => 4,
			TrapKey::Return => 8,
			TrapKey::Signal(_) => 0,
		}
	}

	/// Whether `key` is in the set.
	pub const fn has(self, key: crate::bash::store::TrapKey) -> bool {
		match key {
			crate::bash::store::TrapKey::Signal(sig) => self.signals.contains(sig),
			_ => self.pseudo & Self::bit(key) != 0,
		}
	}

	/// The set with `key` added.
	pub const fn with(self, key: crate::bash::store::TrapKey) -> Self {
		match key {
			crate::bash::store::TrapKey::Signal(sig) => {
				Self { pseudo: self.pseudo, signals: self.signals.with(sig) }
			},
			_ => Self { pseudo: self.pseudo | Self::bit(key), signals: self.signals },
		}
	}

	/// The set without `key`, a pseudo-signal (a signal key is kept).
	pub const fn without(self, key: crate::bash::store::TrapKey) -> Self {
		Self { pseudo: self.pseudo & !Self::bit(key), signals: self.signals }
	}
}

/// The signals of [`Vproc::async_ignored`]: `INT` and `QUIT` ignored, one
/// bit each, and one bit more each for an ignored signal the vproc acts on
/// itself all the same ([`Self::trapped`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AsyncIgnored(u8);

impl AsyncIgnored {
	/// `INT` and `QUIT`, as an asynchronous command starts.
	pub const INT_QUIT: Self = Self(Self::bit(Signal::Int) | Self::bit(Signal::Quit));
	/// Neither signal.
	pub const NONE: Self = Self(0);

	/// The bit of `sig`: none for a signal other than `INT` and `QUIT`.
	const fn bit(sig: Signal) -> u8 {
		match sig {
			Signal::Int => 1,
			Signal::Quit => 2,
			_ => 0,
		}
	}

	/// The [`Self::trapped`] bit of `sig`.
	const fn trapped_bit(sig: Signal) -> u8 {
		Self::bit(sig) << 2
	}

	/// Whether `sig` is ignored.
	pub const fn has(self, sig: Signal) -> bool {
		self.0 & Self::bit(sig) != 0
	}

	/// Whether the vproc acts on `sig` itself, while what it starts ignores
	/// it (kept only while `sig` is ignored): the vproc it forked from had
	/// named `sig` in `trap`, or had this bit itself; bash's fork keeps its
	/// parent's own disposition (`exec::fork_async_ignored` sets it for
	/// `INT`).
	pub const fn trapped(self, sig: Signal) -> bool {
		self.0 & Self::trapped_bit(sig) != 0
	}

	/// The set without `sig`, ignored or trapped.
	pub const fn without(self, sig: Signal) -> Self {
		Self(self.0 & !(Self::bit(sig) | Self::trapped_bit(sig)))
	}

	/// The set with `sig`, if ignored, also [`Self::trapped`].
	pub const fn with_trapped(self, sig: Signal) -> Self {
		if self.has(sig) {
			Self(self.0 | Self::trapped_bit(sig))
		} else {
			self
		}
	}
}

/// `getopts` progress between calls (bash's `sh_optind`, `sh_curopt` and
/// `sh_charindex`): a subshell inherits it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GetoptsState {
	/// The `OPTIND` text the last call stored; another value means the
	/// script assigned `OPTIND` (`OPTIND=1` restarts the scan).
	pub optind: Option<BString>,
	/// Within an option word: its argument index (1-based) and the offset of
	/// its next option letter.
	pub next:   Option<(u32, u32)>,
	/// The scope holding that `OPTIND` (`None`: the shell's own): a new
	/// variable (`local OPTIND=1`) restarts the scan even with the same text.
	pub at:     Option<u32>,
}

impl GetoptsState {
	/// No progress: the next `getopts` starts at `OPTIND`.
	pub const NONE: Self = Self { optind: None, next: None, at: None };
}

/// The job table of one shell: bash's `jobs` array with `js.j_current` and
/// `js.j_previous`. Called by the job builtins, `wait`, `kill`, the
/// scheduler (state changes) and `$!`/`\j`. The root vproc's table is
/// written to the store (`Record::Job`, `MiscKey::JobCurrent`, …) at the
/// end of every step ([`super::state::sync_root`]); a subshell's is in the
/// frames image.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobTable {
	/// Jobs in start order (ascending numbers).
	pub list:     Vec<Job>,
	/// The current job (`%+`, `%%`), by number.
	pub current:  Option<u32>,
	/// The previous job (`%-`), by number.
	pub previous: Option<u32>,
	/// `SIGCHLD` trap runs owed: bash runs the trap once per child that
	/// finished while it was set, however many finished at once.
	pub chld:     u32,
	/// A forked subshell (`( )`, `&`, a pipeline stage, `<( )`): bash runs
	/// it without job control and with an empty job table. A command
	/// substitution keeps both (it lists its parent's jobs).
	pub subshell: bool,
	/// Where a command or process substitution leaves this shell: which
	/// background jobs a signal killed it reports ([`super::killed`]).
	pub comsub:   Comsub,
	/// The statuses of background jobs that left the table (bash's bgp
	/// list: `delete_job`'s `bgp_add`), oldest first, at most [`BGP_MAX`]:
	/// `wait PID` finds one once its job left the table. The root's is in
	/// the store too ([`crate::bash::store::Key::BgPid`]). Boxed and `None`
	/// while empty: one pointer per idle vproc.
	#[expect(clippy::box_collection, reason = "one pointer per idle vproc; a `VecDeque` is four")]
	pub bgp:      Option<Box<VecDeque<SavedStatus>>>,
}

/// How many statuses [`JobTable::bgp`] keeps: bash's `MAX_CHILD_MAX`, the
/// most `js.c_childmax` takes. Past it the oldest kept goes, as bash's
/// circular `bgpids.storage` overwrites its oldest cell.
pub const BGP_MAX: usize = 32_768;

/// A status kept for a job that left the table ([`JobTable::bgp`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedStatus {
	/// The child vproc.
	pub vpid:   Vpid,
	/// The pid `$!` and `jobs -p` showed for it ([`Job::pid`]).
	pub pid:    u32,
	/// How it ended (128 plus the signal's number for one a signal killed).
	pub status: i32,
	/// Its place in the list: kept later than every smaller one (a store
	/// image keeps the order by it).
	pub seq:    u64,
}

/// A shell's place under a command or process substitution (bash
/// `SUBSHELL_COMSUB` and `startup_state`), for its notices of the
/// background jobs a signal killed ([`super::killed`]). bash's
/// `command_substitute` and `process_substitute` set both in the
/// substitution's process (`startup_state` to 2, as a `-c` shell's); each
/// fork of it starts a new `subshell_environment` without the flag
/// (`execute_in_subshell` for a `( … )`, a compound command that is a
/// pipeline stage or runs with `&`; `execute_simple_command`'s child for a
/// simple one) and keeps `startup_state`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Comsub {
	/// Neither, nor a fork of one.
	#[default]
	No,
	/// The substitution's own process, with what it runs without a fork
	/// (a function, `eval`, `.`): it reports none.
	Own,
	/// A fork of one: it reports them, but in posix mode none, as a posix
	/// `-c` shell does not (`startup_state` 2).
	Fork,
}

impl Comsub {
	/// Where a fork of a shell in `self` is.
	pub const fn forked(self) -> Self {
		match self {
			Self::No => Self::No,
			Self::Own | Self::Fork => Self::Fork,
		}
	}
}

/// What a job spec names (bash `get_job_spec`), without its `%`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobLookup {
	/// Job `n` (it may not exist: `%7`).
	Job(u32),
	/// No job (`%+` with an empty table, an unmatched name).
	None,
	/// Several jobs' commands match the name (bash `DUP_JOB`).
	Ambiguous,
}

impl JobTable {
	/// Number of jobs (prompt `\j`).
	pub const fn len(&self) -> usize {
		self.list.len()
	}

	/// No jobs.
	pub const fn is_empty(&self) -> bool {
		self.list.is_empty()
	}

	/// Jobs in start order.
	pub fn iter(&self) -> std::slice::Iter<'_, Job> {
		self.list.iter()
	}

	/// Job `%number`.
	pub fn get(&self, number: u32) -> Option<&Job> {
		self.list.iter().find(|j| j.number == number)
	}

	/// Job `%number`, to update it.
	pub fn get_mut(&mut self, number: u32) -> Option<&mut Job> {
		self.list.iter_mut().find(|j| j.number == number)
	}

	/// The job whose root vproc is `vpid`.
	pub fn by_vpid(&self, vpid: Vpid) -> Option<&Job> {
		self.list.iter().find(|j| j.vpid == vpid)
	}

	/// The job whose root vproc is `vpid`, to update it.
	pub fn by_vpid_mut(&mut self, vpid: Vpid) -> Option<&mut Job> {
		self.list.iter_mut().find(|j| j.vpid == vpid)
	}

	/// The job `pid` names: its virtual pid or its program's OS pid
	/// ([`Job::os_pid`]).
	pub fn by_pid(&self, pid: u32) -> Option<&Job> {
		self.list.iter().find(|j| j.named_by(pid))
	}

	/// Add a background job (bash `stop_pipeline` for an async list): it
	/// takes the number after the highest one in use (bash does not reuse
	/// lower freed numbers until the table is empty) and becomes current
	/// as `reset_current` decides. Returns its number.
	pub fn add(&mut self, id: JobId, vpid: Vpid, text: BString, control: bool, wd: BString) -> u32 {
		let number = self.list.last().map_or(1, |j| j.number.saturating_add(1));
		self.list.push(Job {
			id,
			number,
			vpid,
			text,
			state: JobState::Running,
			control,
			notified: false,
			nohup: false,
			inherited: false,
			wd,
			os_pid: None,
			signal: None,
			procs: None,
			unreaped: false,
		});
		self.reset_current();
		number
	}

	/// The process of vproc `vpid` of one of the jobs ([`Job::procs`]) is
	/// the program of OS pid `pid`.
	pub fn proc_settled(&mut self, vpid: Vpid, pid: u32) {
		if let Some(p) = self
			.list
			.iter_mut()
			.filter_map(|j| j.procs.as_deref_mut())
			.find_map(|procs| procs.get_mut(vpid))
		{
			p.os_pid = Some(pid);
		}
	}

	/// Remove job `number` (bash `delete_job`); a removed current or
	/// previous job makes `reset_current` pick new ones.
	pub fn remove(&mut self, number: u32) -> Option<Job> {
		let i = self.list.iter().position(|j| j.number == number)?;
		let job = self.list.remove(i);
		if self.current == Some(number) || self.previous == Some(number) {
			self.reset_current();
		}
		Some(job)
	}

	/// bash reaped every child that had ended ([`Job::unreaped`]): it does as
	/// it waits for a foreground command (`wait_for`'s `waitchld` takes in
	/// each child that ended, not only the one it waits for).
	pub fn all_reaped(&mut self) {
		for job in &mut self.list {
			job.unreaped = false;
		}
	}

	/// Remove every job `pick` selects, as [`Self::remove`] does.
	pub fn remove_where(&mut self, mut pick: impl FnMut(&Job) -> bool) {
		let mut reset = false;
		let (current, previous) = (self.current, self.previous);
		self.list.retain(|j| {
			let gone = pick(j);
			reset |= gone && (current == Some(j.number) || previous == Some(j.number));
			!gone
		});
		if reset {
			self.reset_current();
		}
	}

	/// The status kept for child `vpid` (bash `bgp_search`).
	pub fn bgp_search(&self, vpid: Vpid) -> Option<i32> {
		self.bgp_saved(vpid).map(|s| s.status)
	}

	/// The entry kept for child `vpid`, the latest.
	pub fn bgp_saved(&self, vpid: Vpid) -> Option<&SavedStatus> {
		self
			.bgp
			.iter()
			.flat_map(|list| list.iter().rev())
			.find(|s| s.vpid == vpid)
	}

	/// The child whose kept status `pid` names (its shown pid or vpid).
	pub fn bgp_named(&self, pid: u32) -> Option<Vpid> {
		self
			.bgp
			.iter()
			.flat_map(|list| list.iter().rev())
			.find(|s| s.pid == pid || s.vpid.0 == pid)
			.map(|s| s.vpid)
	}

	/// Keep `status` for child `vpid`, shown as `pid` (bash `bgp_add`), as
	/// the latest, in place of one kept for the same child; past
	/// [`BGP_MAX`] the oldest goes. The entry kept, and the one gone.
	pub fn bgp_add(
		&mut self,
		vpid: Vpid,
		pid: u32,
		status: i32,
	) -> (SavedStatus, Option<SavedStatus>) {
		let list = self.bgp.get_or_insert_with(Box::default);
		if let Some(i) = list.iter().position(|s| s.vpid == vpid) {
			list.remove(i);
		}
		let seq = list.back().map_or(0, |s| s.seq + 1);
		let saved = SavedStatus { vpid, pid, status, seq };
		list.push_back(saved);
		let gone = if list.len() > BGP_MAX {
			list.pop_front()
		} else {
			None
		};
		(saved, gone)
	}

	/// Forget the status kept for child `vpid` (bash `bgp_delete`).
	pub fn bgp_delete(&mut self, vpid: Vpid) -> Option<SavedStatus> {
		let list = self.bgp.as_mut()?;
		let i = list.iter().position(|s| s.vpid == vpid)?;
		let gone = list.remove(i);
		if list.is_empty() {
			self.bgp = None;
		}
		gone
	}

	/// Forget every status kept (bash `bgp_clear`), returned.
	pub fn bgp_clear(&mut self) -> VecDeque<SavedStatus> {
		self.bgp.take().map_or_else(VecDeque::new, |list| *list)
	}

	fn state(&self, number: Option<u32>) -> Option<JobState> {
		number.and_then(|n| self.get(n)).map(|j| j.state)
	}

	fn is_stopped(&self, number: Option<u32>) -> bool {
		matches!(self.state(number), Some(JobState::Stopped(_)))
	}

	fn is_running(&self, number: Option<u32>) -> bool {
		self.state(number) == Some(JobState::Running)
	}

	/// The newest job older than `before` (all jobs for `None`) that is
	/// stopped (`stopped`) or running (bash `most_recent_job_in_state`).
	fn newest(&self, before: Option<u32>, stopped: bool) -> Option<u32> {
		self
			.list
			.iter()
			.rev()
			.filter(|j| before.is_none_or(|b| j.number < b))
			.find(|j| {
				if stopped {
					matches!(j.state, JobState::Stopped(_))
				} else {
					j.state == JobState::Running
				}
			})
			.map(|j| j.number)
	}

	/// Make `job` the current job and pick a useful previous one (bash
	/// `set_current_job`).
	pub fn set_current(&mut self, job: u32) {
		if self.current != Some(job) {
			self.previous = self.current;
			self.current = Some(job);
		}
		if self.previous != self.current && self.is_stopped(self.previous) {
			return;
		}
		if self.is_stopped(self.current)
			&& let Some(candidate) = self.newest(self.current, true)
		{
			self.previous = Some(candidate);
			return;
		}
		let candidate = if self.is_running(self.current) {
			self.newest(self.current, false)
		} else {
			self.newest(None, false)
		};
		self.previous = candidate.or(self.current);
	}

	/// Choose the current job after a change (bash `reset_current`): a
	/// stopped current job stays; else the previous one if stopped, the
	/// newest stopped one, or the newest running one.
	pub fn reset_current(&mut self) {
		let candidate = if self.is_stopped(self.current) {
			self.current
		} else if self.is_stopped(self.previous) {
			self.previous
		} else {
			self.newest(None, true).or_else(|| self.newest(None, false))
		};
		if let Some(job) = candidate {
			self.set_current(job);
		} else {
			self.current = None;
			self.previous = None;
		}
	}

	/// Resolve a job spec without its leading `%` (bash `get_job_spec`
	/// after the `%`): a number, `%`/`+`/`-`, a command prefix, or `?` and a
	/// substring (matched case-insensitively, as `strcasestr`).
	pub fn lookup(&self, spec: &[u8]) -> JobLookup {
		if !spec.is_empty() && spec.iter().all(u8::is_ascii_digit) {
			return std::str::from_utf8(spec)
				.ok()
				.and_then(|s| s.parse::<u32>().ok())
				.map_or(JobLookup::None, JobLookup::Job);
		}
		let current = |n: Option<u32>| n.map_or(JobLookup::None, JobLookup::Job);
		match spec.first() {
			None | Some(b'%' | b'+') => return current(self.current),
			Some(b'-') => return current(self.previous),
			_ => {},
		}
		let (name, substring) = match spec.strip_prefix(b"?") {
			Some(rest) => (rest, true),
			None => (spec, false),
		};
		let mut found = JobLookup::None;
		for job in self.list.iter().rev() {
			let hit = if substring {
				name.is_empty()
					|| job
						.text
						.windows(name.len())
						.any(|w| w.eq_ignore_ascii_case(name))
			} else {
				job.text.starts_with(name)
			};
			if hit {
				if found != JobLookup::None {
					return JobLookup::Ambiguous;
				}
				found = JobLookup::Job(job.number);
			}
		}
		found
	}
}

/// `$!` of a vproc ([`Vproc::last_bg`]): the last asynchronous child (a
/// background job, a process substitution, a coprocess) and the
/// OS pid of the program it runs, once known ([`Job::os_pid`]). Two words,
/// zero meaning none (no vpid or OS pid is zero): an `Option` pair would
/// grow every vproc (idle vproc ≤ 2 KiB).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastBg {
	vpid: u32,
	os:   u32,
}

impl LastBg {
	/// `$!` names `vpid`, by its virtual pid until [`Self::set_os`].
	pub const fn new(vpid: Vpid) -> Self {
		Self { vpid: vpid.0, os: 0 }
	}

	/// The child `$!` names.
	pub const fn vpid(self) -> Option<Vpid> {
		if self.vpid == 0 {
			None
		} else {
			Some(Vpid(self.vpid))
		}
	}

	/// The OS pid the child is known by, once settled.
	pub const fn os(self) -> Option<u32> {
		if self.os == 0 { None } else { Some(self.os) }
	}

	/// The child runs the program with OS pid `pid`.
	pub const fn set_os(&mut self, pid: u32) {
		self.os = pid;
	}

	/// The pid `$!` expands to: the OS pid, else the virtual pid.
	pub const fn pid(self) -> Option<u32> {
		match (self.os(), self.vpid()) {
			(Some(os), _) => Some(os),
			(None, Some(v)) => Some(v.0),
			(None, None) => None,
		}
	}

	/// `$!` names `v`.
	pub const fn is(self, v: Vpid) -> bool {
		self.vpid != 0 && self.vpid == v.0
	}

	/// `pid` is `$!`'s virtual or OS pid: the child it names.
	pub const fn named_by(self, pid: u32) -> Option<Vpid> {
		if pid != 0 && self.vpid != 0 && (self.vpid == pid || self.os == pid) {
			Some(Vpid(self.vpid))
		} else {
			None
		}
	}
}

/// A background job whose pid is still to be settled, kept by the kernel
/// ([`super::Kernel::bangs`]) for the vproc that may settle it. The
/// external spawned as the job's lone command (or `exec`'d, or a
/// pipeline's last stage's) makes the job known by that program's OS pid
/// ([`Job::os_pid`], `$!`). Another program (or callout) the job runs,
/// also in a command substitution, subshell or pipeline stage of its own
/// ([`super::Kernel::bang_kin`]), keeps its virtual pid: the job waits for
/// it, and it may wait for the shell. Builtins, loops, command
/// substitutions and subshells decide nothing, as bash's forked child may
/// still `exec` its program after them. The job keeps its virtual pid when
/// it ends, when a redirection or `.` would wait on a FIFO or pipe, or
/// once it would make a reader of the pid (`$!`, `jobs -l`/`-p`/`-x`), who
/// waits for the decision, wait: it is stopped or waits for something
/// outside itself, or has run a scheduler slice since the reader parked
/// (`Shell::decide_waited_bangs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bang {
	/// The vproc that decides: the job's own, or the subshell a callout of
	/// its lone command handed the job to.
	pub vproc: Vpid,
	/// The job's vproc (the one `$!` and the job table name).
	pub job:   Vpid,
	/// What may still give the job its program.
	pub stage: BangStage,
}

/// The redirections of a background job's lone command whose open would
/// wait (a FIFO without its other end), kept by the kernel
/// ([`super::Kernel::deferrals`]) while the command resolves: an external
/// applies them itself ([`crate::bash::ChildRedirs`]), so the job has its OS
/// pid at once; anything else applies them here as usual.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deferral {
	/// The vproc running the command.
	pub vproc: Vpid,
	/// Index of the first redirection left (the one whose open would wait).
	pub from:  usize,
	/// Where the command is.
	pub phase: DeferPhase,
	/// The redirections collected for the process (`Collect`), in order.
	pub list:  Vec<crate::bash::host::ChildRedir>,
}

/// Progress of a [`Deferral`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeferPhase {
	/// The redirection stage stopped at the open that would wait; the
	/// command's name resolves next.
	Lookup,
	/// It is an external: the redirection stage resumes, collecting the
	/// rest for the process.
	Collect,
	/// It is not (or its spawn failed): the redirection stage resumes and
	/// opens the rest here.
	Resume,
}

/// The spawn of the external that gives a background job its `$!` ([`Bang`])
/// met a program the kernel refuses as busy (`ETXTBSY`), kept by the kernel
/// ([`super::Kernel::busy`]). bash's forked child is `$!` before its exec,
/// and the script goes on; here a process that waits for the program itself
/// takes its place ([`crate::bash::OnBusy::Child`]), so the spawn first
/// fails at once ([`crate::bash::OnBusy::Fail`]) and the engine renders the
/// report its refusal would print, for that process to print if the program
/// stays busy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BusySpawn {
	/// The refusal is being rendered (its probes may wait).
	Render,
	/// Rendered: the spawn asks for the process that waits.
	Child(crate::bash::OnBusy),
}

impl Vproc {
	/// The vproc a pid operand (`kill`, `wait`, `disown`) names here: a
	/// job's, `$!`'s or a kept status's ([`JobTable::bgp`]) OS pid maps to
	/// its vproc; any other number is taken as a virtual pid.
	pub fn vpid_of(&self, pid: u32) -> Vpid {
		match self.jobs.by_pid(pid) {
			Some(job) => job.vpid,
			None => self
				.last_bg
				.named_by(pid)
				.or_else(|| self.jobs.bgp_named(pid))
				.unwrap_or(Vpid(pid)),
		}
	}

	/// The pid the user knows the child `v` by (`wait -p`): its job's,
	/// `$!`'s or its kept status's OS pid, else its virtual pid.
	pub fn shown_pid(&self, v: Vpid) -> u32 {
		match self.jobs.by_vpid(v) {
			Some(job) => job.pid(),
			None if self.last_bg.is(v) => self.last_bg.os().unwrap_or(v.0),
			None => self.jobs.bgp_saved(v).map_or(v.0, |s| s.pid),
		}
	}
}

/// What may still settle a [`Bang`] with an OS pid.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BangStage {
	/// The job's body is one simple command: its external is the program
	/// (bash's subshell `exec`s it). `eval`, `.` and `source` as that
	/// command run their text at this stage.
	Lone,
	/// Only an `exec`'d external is (`{ exec cmd; } &`, a function called
	/// as the lone command).
	Exec,
	/// A host callout runs as the lone command: it may hand the job to the
	/// subshell it starts ([`crate::bash::ShellApi::exec_subshell_in`],
	/// `nohup`); unless it does, the alias settles virtual when the host
	/// steps the shell again.
	Callout,
	/// The job's body is a pipeline: its last stage, once started, decides
	/// as a job body of its own would (`$!` names the last process).
	Pipeline,
}

/// A running coprocess: its vproc, the variable naming it and the shell's
/// ends of its pipes (unset and closed once it is reaped).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Coproc {
	pub vpid:  Vpid,
	/// `NAME` (`NAME[0]`, `NAME[1]`, `NAME_PID`).
	pub name:  BString,
	/// The fd the shell reads the coprocess's output from (`NAME[0]`).
	pub read:  i32,
	/// The fd the shell writes its input to (`NAME[1]`).
	pub write: i32,
}

impl Vproc {
	/// `BASH_COMMAND`: the source text of the current command.
	pub fn command_text(&self) -> &[u8] {
		self.command.as_ref().map_or(&[][..], |(unit, node)| {
			unit
				.nodes
				.get(*node as usize)
				.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
				.unwrap_or_default()
		})
	}

	/// Code left to run: a run or a frame.
	pub const fn has_code(&self) -> bool {
		!self.runs.is_empty() || !self.frames.is_empty()
	}

	/// Anything left to do: code ([`Self::has_code`]) or diagnostics still
	/// going out (`out`). A subshell is not over until its last message is
	/// out, as bash's child is not until its last `write(2)` returns: a fatal
	/// error queues its message and unwinds every frame in one op, and a
	/// writer thread ([`crate::sys::StdFile`] on a terminal, a socket, a pipe
	/// it could not reopen, and every Darwin pipe) can still hold the message
	/// then, so the vproc must get turns until the thread has settled it.
	pub const fn has_work(&self) -> bool {
		self.has_code() || !self.out.is_empty()
	}

	/// Bash defers trapped signals while waiting for a foreground command.
	/// Not between the commands of a `${ ;}` or `${| ;}` body that bash runs
	/// in the shell itself (in a simple command's words, a compound
	/// command's own redirection): bash runs a pending trap as each command
	/// there ends (`run_pending_traps`), before a later `break` can leave the
	/// trap nothing to run. bash expands a program's redirections, and a
	/// `( … )`'s, in its forked child, so a trap set off there waits for
	/// that child; this shell expands a simple command's redirections before
	/// its name resolves, so it holds a trap from them back whatever the
	/// name runs.
	pub fn waiting_foreground(&self) -> bool {
		self
			.frames
			.last()
			.is_some_and(super::exec::redirected_subshell_starts)
			|| self.frames.iter().enumerate().any(|(i, frame)| {
				frame.scratch.as_ref().is_some_and(|scratch| {
					!scratch.children.is_empty()
						|| match scratch.sub {
							Some(PendingSub::NoFork { .. }) => {
								!self
									.frames
									.get(i + 1)
									.is_some_and(|above| above.kind == FrameKind::NoFork)
									|| scratch
										.exec
										.as_deref()
										.is_some_and(|exec| exec.stage == Stage::Redirect)
									|| super::exec::subshell_redirection(frame)
							},
							Some(_) => true,
							None => false,
						}
						|| matches!(
							scratch.exec.as_ref().and_then(|exec| exec.waiting),
							Some(Awaited::Call(_) | Awaited::Task(_) | Awaited::Ext { .. })
						)
				})
			})
	}

	/// Whether it waits for a forked foreground job: a subshell, a
	/// pipeline stage, an external (bash's `wait_for` of a job, whose
	/// `set_job_status_and_cleanup` runs the `INT` trap); not a command
	/// substitution, which is no job, nor a builtin's callout or task.
	pub fn waiting_for_a_fork(&self) -> bool {
		self.frames.iter().any(|frame| {
			frame.scratch.as_ref().is_some_and(|scratch| {
				!scratch.children.is_empty()
					|| matches!(
						scratch.exec.as_ref().and_then(|exec| exec.waiting),
						Some(Awaited::Ext { .. })
					)
			})
		})
	}

	/// Whether the `wait` builtin is waiting for its jobs (bash's
	/// `this_shell_builtin == wait_builtin` while it waits).
	pub fn in_wait_builtin(&self) -> bool {
		self.frames.iter().any(|frame| {
			frame
				.scratch
				.as_ref()
				.and_then(|s| s.exec.as_ref())
				.is_some_and(|e| {
					e.target == Some(Target::Intrinsic(crate::bash::ids::IntrinsicId::Wait))
						&& matches!(
							e.waiting,
							Some(Awaited::Jobs { .. } | Awaited::AllJobs | Awaited::AnyJob { .. })
						)
						&& !e.wait_for.is_empty()
				})
		})
	}

	/// Whether bash runs with its job list frozen (`jobs_list_frozen` > 0): in
	/// a trap it runs so ([`ScriptKind::Trap`]'s `frozen`), or in the last
	/// stage of a pipeline it runs in the shell (`lastpipe`,
	/// `execute_pipeline`'s `freeze_jobs_list (1)`). No job is reported or
	/// deleted meanwhile, and `wait -n` returns at once.
	pub fn jobs_frozen(&self) -> bool {
		let trap = self.trap_frames != 0
			&& self.frames.iter().any(|f| {
				matches!(f.kind, FrameKind::Script { what: ScriptKind::Trap { frozen: true, .. }, .. })
			});
		trap
			|| (self.mode.dialect() == crate::bash::ids::Dialect::Bash
				&& self.frames.iter().any(|f| f.kind == FrameKind::Stage))
	}

	/// Whether bash deletes no job now (`jobs_list_frozen` ≠ 0): its job list
	/// is frozen ([`Self::jobs_frozen`]), or it runs a function substitution
	/// (`${ …; }`, `${| …; }`: `function_substitute`'s `freeze_jobs_list
	/// (-1)`), where jobs are still reported and marked reported. The next
	/// cleanup outside deletes what was marked.
	pub fn jobs_kept(&self) -> bool {
		self.jobs_frozen()
			|| (self.mode.dialect() == crate::bash::ids::Dialect::Bash
				&& self.frames.iter().any(|f| f.kind == FrameKind::NoFork))
	}
}

/// Why a vproc is parked, and the wake count it parked at.
pub struct Blocked {
	pub key: WaitKey,
	pub at:  u64,
}

/// A submitted script.
pub struct Run {
	pub id:                RunId,
	pub tag:               u64,
	pub src:               Arc<[u8]>,
	pub chain:             OriginChain,
	/// The mode it starts in: [`Script::mode`](super::Script::mode), or the
	/// vproc's mode when the script was submitted.
	pub mode:              ModeId,
	/// The vproc's mode before a run with an explicit mode started, put
	/// back when it ends (a per-run mode does not leak into later runs).
	pub restore_mode:      Option<ModeId>,
	/// [`Script::mode`](super::Script::mode) was given.
	pub explicit_mode:     bool,
	/// [`crate::bash::store::LossyKind`] bits reported outside any
	/// mode-switching call during this run (`Diag::ModeLossy` once per kind).
	pub lossy:             u8,
	/// Root scripts: positional parameters, cwd and exported variables to
	/// install when the script starts.
	pub args:              Option<Vec<BString>>,
	pub cwd:               Option<BString>,
	pub env:               Vec<(BString, BString)>,
	pub started:           bool,
	pub exit_trap_started: bool,
	/// [`Script::too_long_to_host`](super::Script::too_long_to_host).
	pub too_long_to_host:  bool,
	/// [`Script::refusals_to_host`](super::Script::refusals_to_host).
	pub refusals_to_host:  bool,
	/// A host callout's subshell runs it (`nohup`, `timeout`, `xargs`,
	/// `find -exec`): it stands for the external program the callout runs,
	/// so its frame runs no DEBUG trap ([`FrameFlags::no_debug_trap`]).
	pub callout:           bool,
}

/// Where the base frame of a child sits in bash's `parse_and_execute` levels
/// ([`FrameFlags::parse_level`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParseLevel {
	/// Outside every level it starts: every frame but such a child's base.
	#[default]
	Outside,
	/// A child forked inside an `eval`, `.` or trap action: bash's fork keeps
	/// `parse_and_execute_level`, but the child's jumps go to its own top
	/// (`execute_in_subshell`), which is no level of its own.
	Kept,
	/// A command or process substitution, whose text bash runs with
	/// `parse_and_execute`: a level of its own (`command_substitute`,
	/// `process_substitute`).
	Substitution,
}

/// What kind of activation a frame is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FrameKind {
	/// Parses and runs commands from source one at a time: the run's
	/// script, `eval`, `source`.
	Script {
		/// Source bytes.
		src:   BString,
		/// Next command's position.
		pos:   (u32, u32),
		/// Parser state kept between commands (one box, mostly `None`).
		aux:   Option<Box<ScriptAux>>,
		/// What kind of script.
		what:  ScriptKind,
		/// More source is read from fd 0 a line at a time when `src` runs
		/// out or ends inside a command (bash reading its script from
		/// standard input: commands that read fd 0 see the following lines).
		stdin: bool,
	},
	/// A function call (a scope is pushed with it).
	Function {
		/// Name.
		name:     BString,
		/// Its scope holds a [`crate::bash::store::ZshScope`] (a zsh-dialect or
		/// mode-switching call): the return restores from it
		/// (`mode::leave_call`). False for a bash call within bash.
		zsh:      bool,
		/// The call that loaded the function (zsh `execautofn`, which runs
		/// the loaded body with `execode(…, "loadautofunc")`):
		/// `zsh_eval_context` shows `loadautofunc` after its `shfunc`.
		autoload: bool,
	},
	/// The code of a child vproc: `SubExit`/`End` exits the vproc.
	Subshell,
	/// `${ cmd; }` / `${| cmd; }` run in the current shell: `SubExit` pops.
	NoFork,
	/// The last stage of a pipeline run in the current shell (`lastpipe`):
	/// `SubExit` pops, and the `Spawn` op collects its status.
	Stage,
	/// The body of a bash `$(< file)` run in the current shell (bash
	/// `optimize_cat_file`): its `< file` reads the file into `capture`,
	/// the substitution's own buffer, and leaves the shell's fds alone;
	/// `SubExit` pops.
	Cat {
		/// The substitution's buffer. The frames image keeps it by its memory
		/// object (`FrameImage::capture`), not here.
		#[serde(skip)]
		capture: crate::bash::mem::Capture,
	},
	/// The base frame of a job the shell suspended
	/// ([`super::jobctl::suspend`]): a subshell frame that also ends its
	/// vproc when its pc reaches `stop_at` (the end of the top-level
	/// pipeline it took over from the shell).
	Job {
		/// Where the job ends.
		stop_at: u32,
	},
}

/// Parser state a [`FrameKind::Script`] keeps between its commands.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptAux {
	/// Unread alias text left after the last command (read before `pos`),
	/// and the alias names still barred from re-expansion.
	pub pending: Option<(BString, Vec<BString>)>,
	/// zsh `parse_string` (`eval`, traps, `-c`, substitutions): the whole
	/// text is parsed before any of it runs, so every command parses with
	/// the features and aliases of the first.
	pub parse:   Option<ParseSnapshot>,
	/// The text is a command a builtin built (`jobs -x`), which bash runs
	/// with `execute_command`: no line of it is read as input, and none
	/// reports a job ([`super::killed::line_read`]).
	pub no_line: bool,
}

/// The parse context a zsh string keeps for all its commands
/// ([`ScriptAux::parse`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParseSnapshot {
	/// [`crate::bash::syntax::Features`] bits.
	pub features: u32,
	/// The aliases in effect (`None`: none, or expansion off).
	pub aliases:  Option<super::builtins::Aliases>,
}

/// Source of a [`FrameKind::Script`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScriptKind {
	/// The run's own script.
	Run,
	/// `eval`.
	Eval,
	/// `source` / `.` (a `return` target).
	Source,
	/// Shell code the line editor runs (a user widget, a hook function
	/// like `precmd` or `zle-line-init`): the call of a function, which
	/// zsh makes directly, so it shows in no call context of its own
	/// (`zsh_eval_context`, diagnostics); the editor restores `$?`.
	Hook,
	/// A trap action, restoring the interrupted status when it finishes.
	Trap {
		key:               crate::bash::store::TrapKey,
		status:            i32,
		cancel:            Option<i32>,
		return_target:     Option<usize>,
		/// An ERR trap run by `set -e`, or an EXIT trap `exit_shell`
		/// started: the shell exits with `status` when the trap ends.
		exit:              bool,
		/// zsh: the `TRAPNAL` function this frame called ended by `return`
		/// (zsh's `trapreturn`). Only such a non-zero status ends the
		/// interrupted code; a function that falls off its end with one
		/// does not.
		returned:          bool,
		/// bash runs it with the job list frozen (`jobs_list_frozen`): a
		/// `CHLD` trap the `wait` builtin runs, an `INT` trap its wait for
		/// a forked foreground command runs. Nothing reports a job while it
		/// runs ([`super::killed`]).
		frozen:            bool,
		/// An EXIT trap started after `set -e` left a function where bash's
		/// `reset_local_contexts` ran first (the `-c` string's or an `eval`'s
		/// `parse_and_execute`, a script's `reader_loop` outside posix
		/// mode): its jumps see no function context until it calls one.
		outside_functions: bool,
	},
	/// Shell code a builtin runs as zsh's `execode`/`execstring` do with
	/// a context name (`zstyle -e` values, `zregexparse` guards and
	/// actions): it parses whole, shows in `zsh_eval_context` under its
	/// context, reports diagnostics under the caller's name with the line
	/// numbers it was parsed at, and an error in it ends only the code
	/// (recorded in [`crate::bash::store::MiscKey::ZshCodeError`] for the
	/// builtin, which runs again when the frame returns).
	Code(CodeKind),
}

/// What a [`ScriptKind::Code`] frame runs (its `zsh_eval_context` word).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CodeKind {
	/// A `zstyle -e` value (`style`).
	Style,
	/// A `zregexparse` guard (`zregexparse-guard`).
	RegexGuard,
	/// A `zregexparse` action (`zregexparse-action`).
	RegexAction,
}

impl CodeKind {
	/// The context name zsh passes to `execode`/`execstring`.
	pub const fn context(self) -> &'static str {
		match self {
			Self::Style => "style",
			Self::RegexGuard => "zregexparse-guard",
			Self::RegexAction => "zregexparse-action",
		}
	}
}

impl FrameKind {
	pub fn script(src: &[u8], pos: Pos, what: ScriptKind) -> Self {
		Self::Script {
			src: BString::from(src),
			pos: (pos.offset, pos.line),
			aux: None,
			what,
			stdin: false,
		}
	}
}

/// Bits of a [`Frame`] that only a vproc's base frame or a run's first frame
/// sets, in one byte ([`Frame::flags`]): two flags and a [`ParseLevel`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameFlags(u8);

impl FrameFlags {
	const COMMAND_LOOP: u8 = 1;
	const NO_DEBUG_TRAP: u8 = 2;
	/// The two bits of [`Self::parse_level`].
	const PARSE_LEVEL: u8 = 0b1100;
	const PARSE_LEVEL_SHIFT: u32 = 2;

	/// The base frame of a fork: a fatal error in it, run as a forked
	/// simple command, reaches bash's command loop when its forking
	/// shell's would have when it forked (bash's fork copies `top_level`).
	/// Set from [`super::exec::fatal_reaches_command_loop`] of the forking
	/// shell and read there.
	#[must_use]
	pub const fn command_loop(self) -> bool {
		self.0 & Self::COMMAND_LOOP != 0
	}

	/// The base frame of a vproc that runs no DEBUG trap and keeps
	/// `BASH_COMMAND`: a command or process substitution (bash's or zsh's) a
	/// DEBUG trap action started (or one such substitution started), as
	/// bash's and zsh's, so a trap that substitutes does not run itself again
	/// without end (a subshell it starts runs the trap again, as bash's
	/// does); and a host callout's subshell ([`Run::callout`]), which stands
	/// for an external program.
	#[must_use]
	pub const fn no_debug_trap(self) -> bool {
		self.0 & Self::NO_DEBUG_TRAP != 0
	}

	/// Sets [`Self::command_loop`].
	pub const fn set_command_loop(&mut self, on: bool) {
		self.set(Self::COMMAND_LOOP, on);
	}

	/// Sets [`Self::no_debug_trap`].
	pub const fn set_no_debug_trap(&mut self, on: bool) {
		self.set(Self::NO_DEBUG_TRAP, on);
	}

	/// Where the base frame of a child sits in bash's `parse_and_execute`
	/// levels; every other frame is outside them.
	#[must_use]
	pub const fn parse_level(self) -> ParseLevel {
		match (self.0 & Self::PARSE_LEVEL) >> Self::PARSE_LEVEL_SHIFT {
			0 => ParseLevel::Outside,
			1 => ParseLevel::Kept,
			_ => ParseLevel::Substitution,
		}
	}

	/// Sets [`Self::parse_level`].
	pub const fn set_parse_level(&mut self, level: ParseLevel) {
		let bits: u8 = match level {
			ParseLevel::Outside => 0,
			ParseLevel::Kept => 1,
			ParseLevel::Substitution => 2,
		};
		self.0 = (self.0 & !Self::PARSE_LEVEL) | (bits << Self::PARSE_LEVEL_SHIFT);
	}

	const fn set(&mut self, bit: u8, on: bool) {
		if on {
			self.0 |= bit;
		} else {
			self.0 &= !bit;
		}
	}
}

/// One activation: a unit, a pc and its loop, case, time and redirection
/// stacks.
pub struct Frame {
	/// Code being run; `None` for a script frame between commands.
	pub unit:              Option<Arc<Unit>>,
	pub pc:                u32,
	pub kind:              FrameKind,
	pub loops:             Vec<LoopRec>,
	/// Open compound commands: (node, start time) for `CmdEnd`.
	pub enters:            Vec<(u32, u64)>,
	/// `case` subjects, and whether an arm matched yet.
	pub cases:             Vec<(BString, bool)>,
	/// `time` starts.
	pub times:             Vec<TimeMark>,
	/// fds saved by `Redir` ops, innermost last.
	pub redirs:            Vec<Saves>,
	/// Scratch of the op at `pc` while it is parked or calling.
	pub scratch:           Option<Box<Scratch>>,
	/// Lines subtracted from diagnostic line numbers: bash numbers a
	/// command substitution by re-parsing its text from the line of the
	/// command that runs it, so its first command reports that line.
	pub line_shift:        u32,
	/// Exec op whose DEBUG trap has already run (for a `Spawn`, see
	/// [`super::exec::SPAWN_DEBUG`]).
	pub debug_pc:          Option<u32>,
	/// Pseudo-traps installed in this function rather than inherited.
	pub debug_trap_local:  bool,
	pub err_trap_local:    bool,
	pub return_trap_local: bool,
	/// A zsh function call with `PM_TAGGED_LOCAL` in effect (`functions
	/// -T`, `function -T`, or an anonymous function called from such a
	/// call): the named functions it calls run with `xtrace` off.
	pub trace_local:       bool,
	/// zsh: `ERR_EXIT` as it was when the DEBUG trap at this frame's list
	/// marker ([`Self::debug_pc`]) started, put back when it ends.
	pub debug_errexit:     bool,
	/// A failing nested command already ran the ERR trap.
	pub err_reported:      bool,
	/// Called (function, `eval`, `source`, subshell) from a context where
	/// `set -e` is ignored: an `if`/`while`/`until` condition, a `&&`/`||`
	/// list except its last command, a `!` pipeline.
	pub ignore_errexit:    bool,
	/// Bits of a base frame ([`FrameFlags`]). One byte: it takes the padding
	/// byte after `Frame`'s fields smaller than 8 B (two `u32`s, two
	/// `Option<u32>`s and seven `bool`s: 31 B), so `Frame` keeps its size.
	pub flags:             FrameFlags,
	/// The base frame of a child vproc: bash's `line_number` as it forked
	/// the process, which the process names for what it waits for
	/// ([`super::killed::wait_line`]): the last line of a `( … )`, where
	/// bash's parser recorded it (`Subshell->line`; also the line of errors
	/// of the compound commands a `( … )` runs directly), else the line its
	/// parent had reached.
	pub fork_line:         Option<u32>,
	/// A function frame: the getopts state at the call, put back on return
	/// when the function made `OPTIND` local (bash
	/// `sh_getopt_save_istate`/`sh_getopt_restore_istate`). `None` is the
	/// default state: no allocation per call, and 40 bytes less per frame
	/// (idle vproc ≤ 2 KiB).
	pub getopts:           Option<Box<GetoptsState>>,
}

impl Frame {
	pub const fn new(unit: Option<Arc<Unit>>, pc: u32, kind: FrameKind) -> Self {
		Self {
			unit,
			pc,
			kind,
			loops: Vec::new(),
			enters: Vec::new(),
			cases: Vec::new(),
			times: Vec::new(),
			redirs: Vec::new(),
			scratch: None,
			line_shift: 0,
			debug_pc: None,
			debug_trap_local: false,
			err_trap_local: false,
			return_trap_local: false,
			trace_local: false,
			debug_errexit: false,
			err_reported: false,
			ignore_errexit: false,
			flags: FrameFlags(0),
			fork_line: None,
			getopts: None,
		}
	}
}

/// Where a `time`d pipeline started: the monotonic clock and the CPU times
/// of the shell and its children (all in ns), for the report at its end.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeMark {
	/// [`crate::bash::host::Host::now_ns`].
	pub real: u64,
	/// User CPU time of the shell and its waited-for children.
	pub user: u64,
	/// System CPU time of the shell and its waited-for children.
	pub sys:  u64,
}

/// An fd slot saved by a redirection, restored when it ends.
pub struct Saved {
	pub fd:   i32,
	pub prev: Option<FdRef>,
}

/// What one redirection list left for its end to undo ([`Frame::redirs`]):
/// the fd slots it saved, and the `{var}`s a bash `( … )`'s own list made,
/// which bash makes in the subshell's fork: the shell forgets them once
/// that fork is made (the `Spawn` after it), `None` everywhere else.
#[derive(Default)]
pub struct Saves {
	pub fds:  Vec<Saved>,
	#[expect(clippy::box_collection, reason = "moved whole from `ScratchIo::var_fds`")]
	pub vars: Option<Box<Vec<VarFd>>>,
}

impl From<Vec<Saved>> for Saves {
	fn from(fds: Vec<Saved>) -> Self {
		Self { fds, vars: None }
	}
}

/// A loop record (`break`/`continue` targets, the loop's status).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopRec {
	pub kind:       LoopKind,
	/// Status of the last completed body.
	pub status:     i32,
	pub iterations: u32,
	pub exit:       u32,
	pub cont:       u32,
	/// Depths of the frame stacks when the loop started (`break` unwinds
	/// them).
	pub depth:      Depths,
}

/// Lengths of a frame's stacks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Depths {
	pub enters: u32,
	pub cases:  u32,
	pub times:  u32,
	pub redirs: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoopKind {
	While,
	For {
		var:   BString,
		items: Vec<BString>,
		next:  u32,
	},
	Select {
		var:   BString,
		items: Vec<BString>,
		first: bool,
		/// zsh `selectlist`'s `more`: the row the next menu page starts
		/// at (0 for the first page).
		more:  u32,
	},
	/// zsh `repeat N`: passes still to run.
	Repeat {
		left: i64,
	},
	/// zsh `for a b … in words`: each pass assigns the next words to the
	/// variables in turn (missing ones empty).
	ForMulti {
		vars:  Vec<BString>,
		items: Vec<BString>,
		next:  u32,
	},
	/// zsh `{ try-list } always { always-list }`: not a loop (`break` and
	/// `continue` counts skip it). [`LoopRec::exit`] is the pc of the
	/// always-list, [`LoopRec::cont`] the pc after it, [`LoopRec::status`]
	/// the try-list's status once the always-list runs.
	Try {
		/// The always-list is running.
		always:  bool,
		/// What ended the try-list early: resumed after the always-list.
		pending: Option<TryEnd>,
	},
}

/// How a zsh try-list ended early (zsh `exectry`: the `errflag`,
/// `retflag`, `breaks`/`contflag` and pending `exit` it saves around the
/// always-list).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TryEnd {
	/// An error (`errflag`): `TRY_BLOCK_ERROR` is 1 in the always-list.
	Error,
	/// `return n`.
	Return(i32),
	/// `break n` / `continue n`: the loop levels still to leave.
	Break { n: u32, cont: bool },
	/// `exit n` from inside a function (zsh `exit_pending`).
	Exit(i32),
}

/// Bytes still to be written to an fd.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingWrite {
	pub fd:     i32,
	pub bytes:  BString,
	pub off:    usize,
	/// Where the bytes handed off so far went ([`HandedOff`]).
	#[serde(skip)]
	pub handed: HandedOff,
	/// A job to continue (`SIGCONT`) once everything queued before this
	/// entry is out (bash `bg` prints the job, then continues it): an entry
	/// of no bytes ([`Self::then_continue`]), kept when a write to its fd
	/// fails.
	#[serde(default)]
	pub cont:   Option<JobId>,
}

impl PendingWrite {
	/// `bytes` for fd `fd`, nothing written yet.
	pub fn new(fd: i32, bytes: BString) -> Self {
		Self { fd, bytes, off: 0, handed: HandedOff::default(), cont: None }
	}

	/// Continue job `id` once what is queued before this entry is out.
	pub fn then_continue(id: JobId) -> Self {
		Self { cont: Some(id), ..Self::new(1, BString::default()) }
	}
}

/// Where a [`PendingWrite`]'s bytes went once handed off: the object that
/// took them, and the [`Mark`](crate::bash::Mark) of the chunk its writer
/// thread took last ([`crate::bash::File::poll_write_marked`]). The writer
/// settles that chunk before it hands the next one to the same object, so
/// it stops at its first failed chunk and holds one mark at most; the entry
/// is done once its last chunk has settled. The fd may name another object
/// by then (a redirection restored in between), and another writer on the
/// same object may have chunks of its own in flight. Live state of one host
/// file: not saved, and not part of the entry's value.
#[derive(Clone, Debug, Default)]
pub struct HandedOff {
	pub file: Option<crate::bash::FdRef>,
	pub mark: Option<crate::bash::Mark>,
}

impl PartialEq for HandedOff {
	fn eq(&self, _: &Self) -> bool {
		true
	}
}

impl Eq for HandedOff {}

/// One logged expansion step (see `expand`): replaying the log reproduces
/// an expansion that parked on a command substitution without repeating
/// side effects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Atom {
	/// A scalar value (or `None`: unset).
	Str(Option<BString>),
	/// A list value (`$@`, `${a[@]}`).
	List(Vec<BString>),
	/// A finished command substitution.
	Sub { out: BString, status: i32 },
	/// A side effect that already happened.
	Done,
	/// A branch decided on the first pass, whose own side effect would
	/// change the decision on the replay (zsh `${name:=word}`).
	Branch(bool),
	/// An assignment a pass made (zsh `${name::=word}`) and what it
	/// replaced: `old` is `Str(None)` (unset), `Str(Some)` (a scalar) or
	/// `List` (an array); `new` the scalar it left (`None`: an array). The
	/// next pass puts `old` back first while `name` still holds `new`, then
	/// assigns again as it replays, so it sees the first pass's state at
	/// every point.
	Wrote { name: BString, old: Box<Self>, new: Option<BString> },
	/// The binding of `name` at `level` an argument of a declaration
	/// builtin (`declare`, `typeset`, `local`, `export`, `readonly`) was
	/// about to change, as it was on the builtin's first run (`old`: its
	/// value, `None` when unset; `bound`: whether the place an assignment at
	/// `level` lands had the name at all). A run again after a later
	/// argument's `$(…)` parked it puts the binding back before the
	/// argument is redone, so each argument applies once (`declare x+=1
	/// a='($(echo 2))'`); a binding the first run did not have is removed,
	/// not left declared but unset, so a function's `local x` refused over
	/// a readonly global `x` is refused again.
	Bound { name: BString, level: Level, old: Option<Var>, bound: bool },
	/// No binding to put back at this point of a declaration builtin's
	/// replay log: on its first run the argument had none there (its name
	/// is no name reference, no temporary binds it). A run again keeps
	/// that, because the argument's own effect changes what a run again
	/// would find (`local r` shadows the global reference `r` whose target
	/// the first run kept), and a run that logged nothing here would read
	/// the next point's atom
	/// ([`Ctx::rollback_point_once`](super::builtins::Ctx::rollback_point_once)).
	Unbound,
	/// The results, in order, of the arithmetic an argument of a builtin
	/// evaluated on its first run (`declare -i y=w++`, `unset 'c[w++]'`): a
	/// run again takes them and evaluates nothing, so the arithmetic's own
	/// assignments and `RANDOM` draws happen once.
	Arith(Vec<i64>),
}

/// Per-op scratch: expansion replay logs, staged progress and transient
/// handles of the op at the frame's pc.
#[derive(Default)]
pub struct Scratch {
	/// Replay logs, one per expansion site of the op ([`Slot`]).
	pub logs:        [Vec<Atom>; 4],
	/// A command substitution being waited for.
	pub sub:         Option<PendingSub>,
	/// Progress of a staged `Exec` (boxed: it moves to `spare_exec` and
	/// back once per command; a pointer moves, not the 368-byte state).
	pub exec:        Option<Box<ExecState>>,
	/// Redirection, probe and PATH-search progress ([`ScratchIo`]), created
	/// by [`Self::io()`] on first use and kept by [`Self::recycle`].
	pub io:          Option<Box<ScratchIo>>,
	/// Transient handles of the `Exec`.
	pub live:        Live,
	/// Children of a `Spawn` op, with their statuses as they exit.
	pub children:    Vec<(Vpid, Option<i32>)>,
	/// A pipeline `Spawn`'s own progress ([`PipelineWait`]), created on
	/// first use ([`Self::pipeline()`]) and kept, cleared, by
	/// [`Self::recycle`]: one pointer, most ops have none.
	pub pipeline:    Option<Box<PipelineWait>>,
	/// A finished `Exec`'s state kept so the next command reuses its
	/// allocations; never serialized.
	pub spare_exec:  Option<Box<ExecState>>,
	/// Cleared word buffers of finished commands, filled again by the next
	/// expansion (`Expander::pool`); kept by [`Self::recycle`], never
	/// serialized.
	pub spare_words: Vec<BString>,
}

impl Scratch {
	/// Clear for the next op, keeping allocations: a finished `Exec`'s
	/// state becomes the spare.
	pub fn recycle(&mut self) {
		let Self { logs, sub, exec, io, live, children, pipeline, spare_exec, spare_words: _ } = self;
		for log in logs {
			log.clear();
		}
		// Tested first: most ops leave both empty, and an assignment would
		// run their drop glue (a call each) anyway.
		if sub.is_some() {
			*sub = None;
		}
		if let Some(e) = exec.take() {
			*spare_exec = Some(e);
		}
		if let Some(io) = io {
			io.clear();
		}
		if !matches!(live, Live::None) {
			*live = Live::None;
		}
		children.clear();
		if let Some(pipeline) = pipeline {
			pipeline.inline = None;
			pipeline.procs.list.clear();
			pipeline.procs.pipefail = false;
		}
	}

	/// A pipeline `Spawn`'s progress, created on first use.
	pub fn pipeline(&mut self) -> &mut PipelineWait {
		self.pipeline.get_or_insert_with(Box::default)
	}

	/// The last stage of a `Spawn`'s pipeline running in this shell
	/// (`lastpipe`), if any ([`PipelineWait::inline`]).
	pub fn inline(&self) -> Option<InlineStage> {
		self.pipeline.as_ref().and_then(|p| p.inline)
	}

	/// The process of vproc `vpid` of the pipeline the `Spawn` waits for
	/// ([`PipelineWait::procs`]).
	pub fn process_mut(&mut self, vpid: Vpid) -> Option<&mut JobProc> {
		self
			.pipeline
			.as_deref_mut()
			.and_then(|p| p.procs.get_mut(vpid))
	}

	/// The op's I/O progress, created on first use (the first redirection,
	/// probe or PATH search of a scratch that had none). Called where that
	/// progress is written; readers use [`Self::probes`], [`Self::probing`]
	/// or the field, which allocate nothing.
	#[inline]
	pub fn io(&mut self) -> &mut ScratchIo {
		self.io.get_or_insert_with(Box::default)
	}

	/// Answers of the op's file probes and lookups so far (empty without
	/// [`ScratchIo`]); handed to builtins and `[[ ]]` as their cache.
	pub fn probes(&self) -> &[(Probe, ProbeResult)] {
		self.io.as_ref().map_or(&[][..], |io| &io.probes[..])
	}

	/// The probe in flight, if any.
	pub fn probing(&self) -> Option<&Probe> {
		self.io.as_ref().and_then(|io| io.probing.as_ref())
	}
}

/// What a pipeline `Spawn` keeps beside its children ([`Scratch::pipeline`]).
#[derive(Default)]
pub struct PipelineWait {
	/// Its last stage running in this shell (`lastpipe`).
	pub inline: Option<InlineStage>,
	/// Its processes, when the shell waits for it (bash's foreground job's
	/// `PROCESS` list), each with how it ended as it is reaped, and the
	/// `pipefail` it ended under: the notice of one a signal killed names
	/// them ([`super::killed::pipeline_ended`]). None under `lastpipe`, nor
	/// for the pipeline that is a background job's command (that job's,
	/// [`Job::procs`]).
	pub procs:  JobProcs,
}

/// The I/O progress of an op: redirections, the fds they saved, file
/// probes, PATH search, fd reads and pathname-expansion walks. Most ops need
/// none of it (an idle background job's parked `Exec` neither), so a
/// [`Scratch`] holds it boxed and creates it on first use: 232 bytes less per
/// scratch (idle vproc ≤ 2 KiB). A recycled scratch keeps it cleared, so
/// an op that redirects or probes in a loop allocates it once.
#[derive(Default)]
pub struct ScratchIo {
	/// Progress of a `Redir` op or the redirection stage of an `Exec`.
	pub redir:   RedirProgress,
	/// fds saved by the `Exec`'s own redirections.
	pub saved:   Vec<Saved>,
	/// Results of file probes and lookups (pollable builtins, `[[ -f ]]`).
	pub probes:  Vec<(Probe, ProbeResult)>,
	/// The probe whose fs operation is in flight (`Scratch::live`), with its
	/// partial progress.
	pub probing: Option<Probe>,
	/// PATH search of the probe in flight (boxed: the size guard below,
	/// and few ops search).
	pub search:  Option<Box<PathSearch>>,
	/// Bytes read so far by an `Input`/`Read` probe.
	pub input:   Vec<u8>,
	/// The pathname-expansion walk of the `Glob` probe in flight.
	pub walk:    Option<Box<super::glob::Walk>>,
	/// The zsh part ([`ScratchZsh`]), created by zsh code on first use
	/// ([`Self::zsh()`]): a bash op's progress neither carries nor clears it.
	pub zsh:     Option<Box<ScratchZsh>>,
	/// The `{var}` redirections a bash `( … )`'s own `Redir` op made so far
	/// (a simple command's are [`ExecState::var_fds`]), which bash makes in
	/// the subshell's fork: when they fail the shell forgets them at once
	/// ([`super::redir::forget_var_fds`]), else after the fork
	/// ([`Saves::vars`]). No other op takes one. Boxed: few ops have one.
	#[expect(clippy::box_collection, reason = "8 B where a Vec is 24: the size guard below")]
	pub var_fds: Option<Box<Vec<VarFd>>>,
}

impl ScratchIo {
	/// Clear for the next op, keeping the vectors' allocations.
	fn clear(&mut self) {
		let Self { redir, saved, probes, probing, search, input, walk, zsh, var_fds } = self;
		*redir = RedirProgress::default();
		saved.clear();
		probes.clear();
		*probing = None;
		*search = None;
		input.clear();
		*walk = None;
		if let Some(z) = zsh {
			z.clear();
		}
		*var_fds = None;
	}

	/// The op's zsh I/O progress, created on first use.
	pub fn zsh(&mut self) -> &mut ScratchZsh {
		self.zsh.get_or_insert_with(Box::default)
	}
}

/// The I/O progress only zsh code keeps ([`ScratchIo::zsh`]).
#[derive(Default)]
pub struct ScratchZsh {
	/// The zsh filename-generation walk of the `Glob` probe in flight (not
	/// imaged, like [`ScratchIo::walk`]: a restored op restarts its walk).
	pub zglob:     Option<Box<super::zsh::zglob::Walk>>,
	/// zsh `multios`: per fd redirected by this list, whether it is an
	/// output and the objects it was redirected to so far (zsh `mfds`).
	pub multio:    Vec<(i32, bool, Vec<FdRef>)>,
	/// zsh `xpandredir`: a redirection whose target expanded to several
	/// words becomes one redirection per word (index in the list, word),
	/// applied after the list's own; [`RedirProgress::done`] counts on
	/// through them.
	pub more:      Vec<(u32, BString)>,
	/// The `fcntl` lock a history file operation holds (zsh `flock_fd`,
	/// `histfcntllock`), released with the op (not imaged).
	pub hist_lock: Option<Box<dyn crate::bash::fs::File>>,
	/// The results so far of the `StatAll` probe in flight (zsh's `$fpath`
	/// search).
	pub stats:     Vec<Option<crate::bash::fs::Stat>>,
}

impl ScratchZsh {
	/// Clear for the next op, keeping the vectors' allocations.
	fn clear(&mut self) {
		let Self { zglob, multio, more, hist_lock, stats } = self;
		*zglob = None;
		multio.clear();
		more.clear();
		*hist_lock = None;
		stats.clear();
	}
}

/// Progress of a pipeline's last stage run in the current shell.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum InlineStage {
	/// Its frame is running above the `Spawn` op's.
	Running,
	/// It finished with this status.
	Done(i32),
}

/// Which replay log of a [`Scratch`] an expansion uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
	/// Command words, loop lists, case words and patterns, `[[ ]]` operands.
	Words   = 0,
	/// The current redirection's target.
	Redirs  = 1,
	/// Prefix assignment values.
	Assigns = 2,
	/// Expansions a builtin runs itself (`unset 'a[$(cmd)]'`).
	Builtin = 3,
}

/// A command substitution in flight.
pub enum PendingSub {
	/// `$( )`: a child vproc writing into a capture.
	Fork { vpid: Vpid, capture: Capture },
	/// `${ ;}` / `${| ;}`: a `NoFork` frame above this one.
	NoFork { capture: Capture, value: bool },
	/// A zsh hook function call run in the current shell
	/// ([`crate::bash::vm::expand::Stop::ZshSub::here`]): a script frame
	/// above this one; `status` is the caller's `$?`, put back when it ends.
	Here { status: i32 },
	/// A zsh user math function's shell function run in the current shell
	/// ([`crate::bash::vm::expand::Stop::MathCall`]): a function frame above
	/// this one; as [`Self::Here`], with its value ([`VprocZsh::last_math`])
	/// logged too, in the replay log `slot` of the expansion that called it
	/// (an op may expand several: `[[ ]]` operands, then its arithmetic).
	Math { status: i32, slot: Slot },
}

/// Progress through a redirection list.
#[derive(Default)]
pub struct RedirProgress {
	/// Redirections fully applied.
	pub done:    usize,
	/// Expanded target of the current redirection.
	pub target:  Option<BString>,
	/// Pending `open` of the current redirection.
	pub opening: Option<Box<dyn FsPending<Box<dyn crate::bash::fs::File>>>>,
}

/// A file probe or name lookup requested by a pollable builtin or `[[ ]]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Probe {
	/// `stat(path)` (`follow` = not `lstat`).
	Stat { path: BString, follow: bool },
	/// `stat` of each path in turn, following links, up to the first that
	/// names a file at one of the indices `ends` (zsh's `$fpath` search: a
	/// definition file ends it, a word code file it passes does not):
	/// [`ProbeResult::Stats`], as many as were asked. One probe for a
	/// stretch of the search that would otherwise ask (and restart its
	/// builtin) once per path; a hit never waits on the directories after
	/// it.
	StatAll { paths: Vec<BString>, ends: Vec<u32> },
	/// Whether a zsh word code digest holds a loadable function
	/// ([`DumpQuery`]): [`ProbeResult::Ok`]. Read once per digest and
	/// remembered by the shell ([`super::Kernel::dump_funcs`]): an `$fpath`
	/// search asks of the same digests for every function.
	DumpHas(Box<DumpQuery>),
	/// `access(path, mode bits)`.
	Access { path: BString, mode: u8 },
	/// PATH search for a command name over `$PATH` = `path`.
	Path { name: BString, path: BString },
	/// Whole-file read (`source`).
	Read { path: BString },
	/// `cd` target validation.
	Chdir { path: BString },
	/// Input from an fd up to a delimiter (`read`): `delim` `None` reads
	/// to EOF, else the read ends with the `lines`-th delimiter (1 but for
	/// `mapfile`); `nchars` caps the count; `part` numbers successive reads
	/// of one command (continuation lines, `select` re-prompts); `timeout_ns`
	/// gives up after that long without complete input (`read -t`, `TMOUT`).
	/// Nothing past the end is consumed: a regular file's read-ahead is given
	/// back, other fds are read a byte at a time. `fd`
	/// [`Probe::TERMINAL_FD`] reads the shell's terminal
	/// ([`super::jobctl::open_key_terminal`]).
	Input {
		fd:         i32,
		delim:      Option<u8>,
		lines:      u32,
		nchars:     Option<usize>,
		part:       u32,
		timeout_ns: Option<u64>,
	},
	/// Whether fd has input available, without reading it (`read -t 0`).
	Ready { fd: i32 },
	/// Pathname expansion of an escaped pattern, relative to the cwd.
	Glob { pattern: BString, opts: super::glob::GlobOpts },
	/// The canonical physical path of an absolute path (zsh's `:A`/`:P`
	/// modifiers): [`ProbeResult::Path`], `None` when it does not resolve.
	RealPath { path: BString },
	/// An fd-level operation of a zsh module builtin (`sysread`, `zselect`,
	/// `sysopen`, sockets): [`ProbeResult::Fd`]. Asked by builtins only
	/// (performed by [`super::probe::perform_mut`]).
	Fd(Box<super::fdprobe::FdProbe>),
	/// A filesystem request answered with its `errno` (zsh/files, zsh/stat,
	/// zsh/attr, zsh/mapfile): [`ProbeResult::Fs`]. `seq` numbers the
	/// asker's requests, so one made twice is asked twice.
	Fs { seq: u32, req: Box<super::fsprobe::FsReq> },
	/// An operation of the zsh/zftp `zftp` builtin (network, terminal,
	/// files): [`ProbeResult::Zftp`]. `seq` numbers the builtin's
	/// operations within the command. Performed by
	/// [`super::probe::perform_mut`].
	Zftp { seq: u32, op: Box<super::builtins::zsh_mod_zftp::ZftpOp> },
	/// A filesystem or clock step of a history file operation
	/// ([`super::builtins::history::io`]): [`ProbeResult::Hist`]. `seq`
	/// numbers the operation's steps.
	Hist { seq: u32, op: Box<super::builtins::history::io::HistOp> },
}

/// The question of a [`Probe::DumpHas`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DumpQuery {
	/// The digest.
	pub path:     BString,
	/// The function (metafied).
	pub name:     BString,
	/// The digest's modification time, as `stat` saw it.
	pub mtime_ns: i64,
	/// The digest's size, as `stat` saw it.
	pub size:     u64,
}

impl Probe {
	/// The `fd` of a [`Probe::Input`] or [`Probe::Ready`] that reads the
	/// shell's terminal (`read -k`), not a descriptor of the fd table.
	pub const TERMINAL_FD: i32 = i32::MIN;
}

/// Answer of a [`Probe`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProbeResult {
	Stat(Option<crate::bash::fs::Stat>),
	/// The answers of a [`Probe::StatAll`], in its order.
	Stats(Vec<Option<crate::bash::fs::Stat>>),
	Ok(bool),
	Path(Option<BString>),
	/// File contents, or the `strerror` text of the failure.
	Bytes(Result<BString, BString>),
	Input {
		data:      BString,
		eof:       bool,
		/// The timeout passed first (`data` holds the partial input).
		timed_out: bool,
	},
	/// Matching paths, sorted (empty: no match).
	Paths(Vec<BString>),
	/// Answer of a [`Probe::Fd`].
	Fd(Box<super::fdprobe::FdAnswer>),
	/// Answer of a [`Probe::Fs`].
	Fs(super::fsprobe::FsResult),
	/// Answer of a [`Probe::Zftp`].
	Zftp(Box<super::builtins::zsh_mod_zftp::ZftpAns>),
	/// Answer of a [`Probe::Hist`].
	Hist(Box<super::builtins::history::io::HistAnswer>),
}

/// Serializable progress of an `Exec` (survives externalize/restore).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecState {
	pub stage:         Stage,
	pub tag:           CmdTag,
	pub t0:            u64,
	pub argv:          Vec<BString>,
	/// The words are expanded (`argv`, `compound` are final).
	pub expanded:      bool,
	/// argv indexes of compound-assignment words (`declare a=(…)`).
	pub compound:      Vec<u32>,
	/// Fields still to pathname-expand: `(argv index, escaped pattern)`.
	pub globs:         Vec<(u32, BString)>,
	/// Prefix assignments as `(name, shown value)` for events.
	pub assigns:       Vec<(BString, BString)>,
	/// Expanded prefix assignments: subscript and value.
	pub values:        Vec<(Option<BString>, AssignValue)>,
	/// `set -k`: `words` indexes of the assignment words taken out of
	/// `argv`; their values follow the prefix ones in `values`.
	pub keywords:      Vec<u32>,
	/// argv indexes of single fields from words written as array
	/// references ([`super::builtins::Ctx::arrayref`]).
	pub arrayref:      Vec<u32>,
	pub target:        Option<Target>,
	pub waiting:       Option<Awaited>,
	/// A temporary scope (builtin environment) was pushed for this command.
	pub scoped:        bool,
	/// Control transfer to perform once the output is written.
	pub control:       Option<Transfer>,
	/// `Task::checkpoint` bytes taken at externalize (a boxed slice: the
	/// size guard below counts every byte of this state).
	pub checkpoint:    Option<Box<[u8]>>,
	/// Command output still to be written.
	pub writes:        VecDeque<PendingWrite>,
	pub status:        i32,
	/// Status of the last command substitution (`$?` of `x=$(…)`).
	pub sub_status:    Option<i32>,
	/// Children `wait` waits for.
	pub wait_for:      Vec<Vpid>,
	/// `exec command`: how the command replaces the shell.
	pub exec_as:       Option<Box<ExecAs>>,
	/// `wait -p var`: the variable that gets the waited child's pid.
	pub wait_into:     Option<Box<BString>>,
	/// Run through `command`: a special builtin's failure does not end a
	/// posix shell.
	pub via_command: bool,
	/// The prefix the command's words start with, as bash's
	/// `execute_simple_command` and `execute_builtin` read it: the outer
	/// one, not the last (`command builtin export` is `command`'s).
	pub prefix:      Prefix,
	/// The awaited frame was pushed by the builtin, which runs again when
	/// it returns ([`Control::Resume`](super::builtins::Control::Resume)).
	pub resume:        bool,
	/// Times the builtin ran again after a frame it pushed returned.
	pub resumed:       u32,
	/// A forked pipeline element's builtin or function was put one
	/// subshell level down ([`super::exec::raise_element_level`]), once.
	#[serde(default)]
	pub raised:        bool,
	/// The `{var}` redirections made so far of a command bash makes them for
	/// in its fork (an external, a name not found, a null command that
	/// forks): neither the fd nor the value reaches the shell, which forgets
	/// them when they fail or when the command ends
	/// ([`super::redir::forget_var_fds`]). No other command takes one.
	/// Boxed: few commands have one.
	#[expect(
		clippy::box_collection,
		reason = "8 B where a Vec is 24: the size guard below counts every byte"
	)]
	pub var_fds:       Option<Box<Vec<VarFd>>>,
	/// bash's notice of the command a signal killed, written to the shell's
	/// own standard error once the command's redirections are undone
	/// ([`super::killed`]).
	#[serde(default)]
	pub notice:        Option<Box<BString>>,
	/// The external runs in place of the shell: the last command of a `-c`
	/// string the real shell runs without a fork ([`super::killed::in_place`]).
	/// A signal sent to the shell is the program's then, as for `exec`.
	#[serde(default)]
	pub in_place:      bool,
	/// bash runs this external with `exec` in the subshell's, job's or
	/// stage's own process ([`super::killed::subshell_exec`]): its end is
	/// the process's ([`super::transparent`]).
	#[serde(default)]
	pub subshell_exec: bool,
}

/// A `{var}` redirection bash makes in a fork (a command bash forks for, a
/// `( … )`'s own): the fd, and the variable's name and declared binding
/// before it took the fd (`None`: unbound).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VarFd {
	pub fd:    i32,
	pub name:  BString,
	pub prior: Option<crate::bash::store::Var>,
}

/// The prefix word a simple command starts with ([`ExecState::prefix`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Prefix {
	/// No prefix: the command word itself.
	#[default]
	None,
	/// `command` (bash's `CMD_COMMAND_BUILTIN`, every leading one).
	Command,
	/// `builtin`: bash runs `builtin_builtin`, which runs the builtin it
	/// names.
	Builtin,
}

/// Options of `exec [-cl] [-a name] command`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecAs {
	/// `-c`: an empty environment.
	pub clear_env: bool,
	/// `-l`: `-` before `argv[0]`.
	pub login:     bool,
	/// `-a name`: `argv[0]`.
	pub argv0:     Option<BString>,
}

/// A control transfer requested by a builtin (`return`, `break`, `exit`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Transfer {
	Return(i32),
	Break {
		n:    u32,
		cont: bool,
	},
	/// The shell exits with this status by this jump (it decides what the
	/// `time`s the jump leaves report).
	Exit(i32, super::exec::Jump),
	/// The rest of the line is abandoned with this status (a `-c` string
	/// whole).
	DiscardAll(i32),
	/// `exec command`: the shell exits with the command's status.
	Exec,
}

/// An expanded assignment value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssignValue {
	Scalar(BString),
	/// `(…)`: `(key, append, value)` with keys as written (expanded).
	Array(Vec<(Option<BString>, bool, BString)>),
}

/// Stages of `Exec`: each keeps its results here, so a wake
/// or a restore resumes the same stage and nothing earlier re-runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Stage {
	/// Expand words to fields (side effects, no fs calls).
	Expand,
	/// Apply redirections (`open` through `Fs`).
	Redirect,
	/// Resolve the name; PATH search through `Fs`.
	Lookup,
	/// Start the command (builtins run here, re-run after each probe).
	Dispatch,
	/// Wait for a callout, task, external or called frame.
	Await,
	/// Write the command's own output.
	Output,
	/// Report and finish.
	Finish,
	/// The redirections of a command bash forks for failed (its `status` is
	/// the fork's): resolve the name, as bash does in the shell before it
	/// forks (hashing it), then finish; the command runs no further.
	FailedLookup,
}

/// What a command name resolved to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Target {
	Function(BString),
	Intrinsic(IntrinsicId),
	Tool(ToolRef),
	Native(NativeRef),
	Device(NativeRef),
	SelfShell,
	External(BString),
	/// An external without `#!` that the OS refused (`ENOEXEC`): read it and
	/// run it as a script in a subshell, as bash does.
	Script(BString),
	/// zsh `zexecve`: the `#!` interpreter run in place of a script the OS
	/// refused (an external that gets no second substitution).
	Interp(BString),
	/// PATH search in progress.
	Search,
	NotFound,
	/// The OS refused to execute `path` with error `code` (raw OS error,
	/// not `ENOEXEC`): probes decide bash's message (`Is a directory`, `bad
	/// interpreter`, `required file not found`, the error itself).
	Refused {
		path: BString,
		code: i32,
	},
}

impl Target {
	pub const fn kind(&self) -> ResolvedKind {
		match self {
			Self::Function(_) => ResolvedKind::Function,
			Self::Intrinsic(_) => ResolvedKind::Intrinsic,
			Self::Tool(_) => ResolvedKind::Tool,
			Self::Native(_) => ResolvedKind::Native,
			Self::Device(_) => ResolvedKind::Device,
			Self::SelfShell => ResolvedKind::SelfShell,
			Self::External(_) | Self::Script(_) | Self::Interp(_) | Self::Refused { .. } => {
				ResolvedKind::External
			},
			Self::Search | Self::NotFound => ResolvedKind::NotFound,
		}
	}
}

impl From<Resolved> for Target {
	fn from(r: Resolved) -> Self {
		match r {
			Resolved::Intrinsic(id) => Self::Intrinsic(id),
			Resolved::Tool(t) => Self::Tool(t),
			Resolved::Native(n) => Self::Native(n),
			Resolved::Device(n) => Self::Device(n),
			Resolved::SelfShell => Self::SelfShell,
			Resolved::External(p) => Self::External(p),
			Resolved::NotFound => Self::NotFound,
		}
	}
}

/// PATH search state: candidates and the probe in progress.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathSearch {
	pub cands:         Vec<BString>,
	pub idx:           usize,
	/// The candidate passed `stat`; `access(X)` is next.
	pub checking_exec: bool,
	/// The first regular file that is not executable: bash's
	/// `FS_EXEC_PREFERRED` finds it when no candidate is executable.
	pub nonexec:       Option<usize>,
}

/// What an `Exec` waits for in `Stage::Await`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Awaited {
	Call(CallId),
	Task(NativeRef),
	Ext {
		pid: u32,
	},
	/// A pushed frame (function, `eval`, `source`) to return.
	Frame,
	/// Background children (`wait id …`); the status is the last one's.
	/// Without `force` (`wait -f`) a job that stops ends the wait (status
	/// 128 + the stop signal), as in bash with job control.
	Jobs {
		force: bool,
	},
	/// Every background child (`wait` without operands); the status is 0.
	AllJobs,
	/// The first of the children to finish (`wait -n`); its status. Once it
	/// waited, `waited` is how many of them had finished then: when one
	/// more did, bash's second pass takes any finished job, a reported one
	/// too (`wait_for_any_job`).
	AnyJob {
		waited: Option<u32>,
	},
}

/// Transient handles; never serialized.
#[derive(Default)]
pub enum Live {
	#[default]
	None,
	Stat(Box<dyn FsPending<Stat>>),
	Access(Box<dyn FsPending<()>>),
	/// `realpath` of a `RealPath` probe in flight.
	Path(Box<dyn FsPending<BString>>),
	/// `open` of a `Read` probe in flight.
	Open(Box<dyn FsPending<Box<dyn crate::bash::fs::File>>>),
	/// The opened file of a `Read` probe.
	File(Box<dyn crate::bash::fs::File>),
	/// The opened file of a `history` write, with what its writer thread
	/// took and has not written yet
	/// ([`Unsettled::poll_write_file`](crate::bash::Unsettled::poll_write_file)).
	Write(Box<(Box<dyn crate::bash::fs::File>, crate::bash::Unsettled)>),
	Task(Box<dyn Task>),
	Ext(Box<dyn ExtProc>),
	/// [`Host::spawn`](crate::bash::Host::spawn) of the external of a
	/// `Dispatch` still in flight: no process exists yet.
	Spawn(crate::bash::host::SpawnFuture),
	/// The timer of an `Input` probe with a timeout.
	Timer(Box<dyn crate::bash::host::Timer>),
	/// `read_dir` of a glob walk in flight.
	OpenDir(Box<dyn FsPending<Box<dyn crate::bash::fs::DirIter>>>),
	/// The listing of a glob walk.
	Dir(Box<dyn crate::bash::fs::DirIter>),
	/// A socket or lock operation of a [`Probe::Fd`] in flight.
	Fd(Box<super::fdprobe::FdLive>),
	/// A request of a [`Probe::Fs`] in flight.
	Fs(Box<super::fsprobe::FsLive>),
	/// An operation of a [`Probe::Zftp`] in flight (sockets, timers).
	Zftp(Box<super::builtins::zsh_mod_zftp::ZftpLive>),
}

impl Live {
	/// A pending idempotent fs op (dropped by a suspend, re-issued later).
	/// Reading a regular file again from the start is; reading a pipe, FIFO
	/// or device is not (the bytes taken are gone, and closing the reader
	/// can break the writer), so a suspend keeps it and externalize reports
	/// it lost. A pending spawn counts too: it has made no process, so
	/// dropping it spawns nothing and the `Dispatch` stage asks again.
	pub fn is_idempotent_fs(&self) -> bool {
		match self {
			Self::Stat(_)
			| Self::Access(_)
			| Self::Path(_)
			| Self::OpenDir(_)
			| Self::Dir(_)
			| Self::Spawn(_) => true,
			// A FIFO open is a rendezvous with the other end.
			Self::Open(open) => open.reissuable(),
			Self::Fd(live) => live.is_idempotent(),
			Self::Fs(live) => live.idempotent,
			Self::File(file) => file.kind() == crate::bash::fs::FileKind::Regular,
			Self::Write(w) => w.0.kind() == crate::bash::fs::FileKind::Regular,
			// Network traffic is not asked twice.
			Self::Task(_) | Self::Ext(_) | Self::Timer(_) | Self::Zftp(_) | Self::None => false,
		}
	}
}

// Size guards for the idle-vproc target (≤ 2 KiB): an idle background job
// holds one boxed `Vproc`, one `Frame`, one boxed `Scratch` and one boxed
// `ExecState`, so every byte here is a byte per idle vproc. Raise a bound
// only with the testkit `memory` bench's numbers in hand.
// zsh support added the boxed zsh side table `Vproc::zsh` (8 B; `Frame` is
// unchanged, its zsh state lives there and in `FrameKind`): the memory
// bench measured 1,785 B per idle vproc with it (target ≤ 2,048).
// Host lineage (`Vproc::lineage`, 8 B: a `u32` label and a flag) added at
// most 8 B to that, still under 2,048. The resumable `mapfile -C` counter
// (`ExecState::resumed`, 368 → 376 B): the bench measured 1,832 B per idle
// vproc with both. The line editor's boxed state (`Vproc::zle`, 8 B) brings
// that to at most 1,840 B. The forking shell's loop count
// (`Vproc::outer_loops`) is a `u16` beside a `u16` `Vproc::trap_frames`,
// in the 4 bytes `trap_frames` had; a `break` waiting in `${ }`
// (`Vproc::pending_break`, boxed, 8 B) brings it to at most 1,848 B, and
// bash's kept statuses (`JobTable::bgp`, one pointer, `None` while empty)
// to at most 1,856 B. bash's pending notice of a killed command
// (`ExecState::notice`, 8 B) and bash's asynchronous ignore of `INT` and
// `QUIT` (`Vproc::async_ignored`, one byte, in place of a store record in
// each background vproc's image: the bench, a debug build, measured 2,458
// → 1,879 B per idle vproc for that move alone) fit the bounds below with
// the rest; the idle bench gives the figure for the whole. A release that
// carries three landings, each within the bounds alone, measures more than
// any of them (rustc `size_of`, x86-64 Linux): a forked vproc's own
// `$RANDOM` and `$SECONDS` clock (`Vproc::clock`: Vproc 656 → 688 B), bash's
// kept `wait` statuses and its killed-command notice (`JobTable::bgp`,
// `ExecState::notice`: Vproc 656 → 664 B, ExecState 376 → 384 B) and the
// EXIT trap's jump kinds (`ExecState::prefix`,
// `ScriptKind::Trap::outside_functions`: no growth alone) give Vproc 696 B,
// Frame 264 B and ExecState 392 B together. `getopts` progress, process
// substitutions, coprocesses, `local -` saves and `ulimit` values, 144 B
// that most vprocs leave empty, then moved behind one pointer
// (`Vproc::rare`): Vproc 560 B, 136 B less per idle vproc (the bench's
// loop, release build, x86-64 Linux: 2,112 to 2,184 B, from 2,248 to 2,320).
const _: () = assert!(size_of::<Vproc>() <= 560, "Vproc grew (idle vproc ≤ 2 KiB)");
const _: () = assert!(size_of::<Frame>() <= 264, "Frame grew (idle vproc ≤ 2 KiB)");
const _: () = assert!(size_of::<Scratch>() <= 216, "Scratch grew (idle vproc ≤ 2 KiB)");
const _: () = assert!(size_of::<ExecState>() <= 392, "ExecState grew (idle vproc ≤ 2 KiB)");
// An op that redirects or probes keeps a `ScratchIo` (cleared per op): its
// zsh-only progress lives in the boxed `ScratchZsh` (zsh support grew it by one
// pointer only; `RedirProgress` not at all).
const _: () = assert!(size_of::<ScratchIo>() <= 248, "ScratchIo grew (zsh support is zero cost)");
const _: () =
	assert!(size_of::<RedirProgress>() <= 48, "RedirProgress grew (zsh support is zero cost)");

/// `size_of` of the structures an idle vproc holds, by name: the testkit
/// `memory` bench prints them as its `memory sizes:` line beside the bytes
/// per idle vproc. Measurement only.
pub const fn vproc_layout() -> [(&'static str, usize); 5] {
	[
		("Vproc", size_of::<Vproc>()),
		("Frame", size_of::<Frame>()),
		("Scratch", size_of::<Scratch>()),
		("ScratchIo", size_of::<ScratchIo>()),
		("ExecState", size_of::<ExecState>()),
	]
}

#[cfg(test)]
mod tests {
	use super::{BGP_MAX, JobTable};
	use crate::bash::ids::Vpid;

	// Failure mode: past `BGP_MAX` the status of the smallest vproc number
	// went, not the oldest kept (bash's circular `bgpids.storage` overwrites
	// its oldest cell).
	#[test]
	fn the_oldest_kept_status_goes_first() {
		let mut jobs = JobTable::default();
		// Kept largest vproc first: the oldest kept has the largest number.
		let top = u32::try_from(BGP_MAX).expect("BGP_MAX fits u32") + 100;
		for n in 0..u32::try_from(BGP_MAX).expect("BGP_MAX fits u32") {
			assert_eq!(jobs.bgp_add(Vpid(top - n), top - n, 1).1, None);
		}
		let (_, gone) = jobs.bgp_add(Vpid(1), 1, 2);
		assert_eq!(gone.map(|s| s.vpid), Some(Vpid(top)), "the oldest kept goes");
		assert_eq!(jobs.bgp_search(Vpid(top)), None);
		assert_eq!(jobs.bgp_search(Vpid(1)), Some(2));
		// Kept again, a status is the latest: the next to go is the one after.
		assert_eq!(jobs.bgp_add(Vpid(top - 1), top - 1, 3).1, None);
		let (_, gone) = jobs.bgp_add(Vpid(2), 2, 4);
		assert_eq!(gone.map(|s| s.vpid), Some(Vpid(top - 2)));
		assert_eq!(jobs.bgp_search(Vpid(top - 1)), Some(3));
		assert_eq!(jobs.bgp.as_ref().map_or(0, |list| list.len()), BGP_MAX);
	}
}
