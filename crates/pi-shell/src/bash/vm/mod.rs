//! The VM: shells, virtual processes and the cooperative scheduler.
//!
//! [`Shell::step`] runs ready virtual processes round-robin, up to 1024 ops
//! each per turn, and returns when a script finishes, a host callout is
//! needed, every vproc is blocked, the control word asks for a pause or a
//! suspend, or the [`Budget`] runs out. Every op dispatch is a safepoint: the
//! dispatch loop loads the control word before each op.

mod api;
pub(crate) mod arith;
mod builtins;
mod callstack;
mod command;
mod control;
mod dynvars;
mod exec;
mod expand;
mod fdprobe;
mod frames;
mod fsprobe;
mod glob;
mod jobctl;
mod killed;
mod locale;
mod mode;
mod nested;
mod orphans;
mod pattern;
mod probe;
mod proc;
pub mod quote;
mod redir;
mod state;
mod untrapped;
mod xtrace;
mod zle;
mod zsh;

use std::{
	collections::{HashMap, HashSet, VecDeque},
	sync::Arc,
	task::Waker,
};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

/// zsh/newuser's startup check, for the process shell's startup files.
pub use self::builtins::zsh_mod_newuser::startup_scripts as newuser_startup_scripts;
pub use self::{
	api::ShellApi,
	arith::Cache as ArithCache,
	control::{ControlHandle, IoPoll, WakeToken},
	frames::FRAMES_VERSION,
	pattern::Cache as PatternCache,
	proc::{Run, Vproc, vproc_layout},
	text::TextKind,
	zsh::zpattern::Cache as ZshPatternCache,
};
use self::{
	control::{CANCEL, Ctl, OS_SIGNAL, PAUSE, RESUME, SIGNAL, SUSPEND},
	proc::{Frame, FrameKind, Live, PendingWrite, ScriptKind},
	state::{Root, Var},
};
use crate::bash::{
	Image,
	diag::{Diag, DiagSite, render},
	engine::Engine,
	error::ShellError,
	event::{AssignScope, Event, EventData, EventMask, Origin, OriginChain, OriginLink, WaitKey},
	fd::{FdOrigin, FdRef, FdTable},
	fs::File,
	host::{EnvView, Host, StdFd, Verdict},
	ids::{CallId, CmdTag, JobId, ModeId, RunId, ToolRef, UnitId, Vpid},
	image::Records,
	ir::{self, Unit},
	signal::{DefaultAction, SigTarget, Signal},
	store::{Attrs, Change, Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, VarValue},
};

/// Ops a vproc runs per scheduler turn.
const SLICE: u32 = 1024;

/// bash version this engine implements (`$BASH_VERSION`).
pub const BASH_VERSION: &str = "5.3.0(1)-release";

/// Largest buffer a kernel keeps for reuse (the spare syntax tree, the unit
/// blob encoder): every ordinary command fits, and a huge one's buffers are
/// freed instead of held for the shell's lifetime.
const SPARE_BUFFER_BYTES: usize = 1 << 20;

/// Unit ids [`Kernel::written`] remembers before it starts over.
const WRITTEN_MAX: usize = 1 << 16;

/// Engine types are `Send`; hosts move shells between threads.
const _: () = {
	const fn send<T: Send>() {}
	send::<Shell>();
	send::<ToolCall>();
	send::<ControlHandle>();
};

mod text {
	/// Kind of text parsed at run time.
	#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
	pub enum TextKind {
		/// Arithmetic text (bash expands it as if double-quoted).
		Arith,
		/// Arithmetic text bash expands unquoted: an array subscript or an
		/// associative key (`expand_subscript_string`).
		ArithUnquoted,
		/// A `[[ ]]` arithmetic operand with a subscript: bash expands it
		/// with `Q_ARITH` and not as if double-quoted (`cond_expand_word`).
		ArithOperand,
		/// An unquoted here-document body.
		HereDoc,
		/// The inside of a compound array value given as a string
		/// (`declare -a d='($a)'`), parsed as the list of `declare __=(…)`.
		Compound,
	}
}

/// The host and the store, lent to the engine for one call.
///
/// The executor builds one per call from its rquickjs-backed host and store,
/// so no `'js` lifetime enters engine structs.
pub struct Cx<'a> {
	/// Side effects.
	pub host:  &'a mut dyn Host,
	/// Persistent state.
	pub store: &'a mut dyn StateStore,
}

/// Initial state of a new shell.
#[derive(Clone, Debug)]
pub struct ShellInit {
	/// Starting mode. A zsh-dialect shell starts with that emulation's
	/// options, and takes [`Self::options`] as zsh option names (`no`
	/// prefix allowed).
	pub mode:        ModeId,
	/// `$0`; also the prefix of diagnostics.
	pub argv0:       BString,
	/// Positional parameters.
	pub args:        Vec<BString>,
	/// Imported environment (names that are not identifiers are skipped;
	/// `BASH_FUNC_name%%` entries define exported functions).
	pub env:         Vec<(BString, BString)>,
	/// Working directory (absolute).
	pub cwd:         BString,
	/// Interactive shell semantics.
	pub interactive: bool,
	/// `set -o` / `shopt` names to set.
	pub options:     Vec<(BString, bool)>,
	/// `$$` (persisted across restores); zero selects [`Host::shell_pid`].
	pub shell_pid:   u32,
	/// Startup files (`path`, contents) the shell sources, in order, before
	/// its first script: what
	/// [`crate::bash::invocation::ShellArgs::startup_files`] names and the
	/// host found (`BASH_ENV`, a login shell's profiles).
	pub startup:     Vec<(BString, BString)>,
	/// Unexported parameters a zsh shell sets from its command line before
	/// its startup files: `ZSH_EXECUTION_STRING` (the `-c` string) and
	/// `ZSH_SCRIPT` (the script file).
	pub zsh_params:  Vec<(BString, BString)>,
	/// The system zsh's function directories, which a zsh shell's `fpath`
	/// starts with when the environment sets no `FPATH` (zsh's compiled-in
	/// `FPATH_DIR` and its subdirectories). `None`: zsh 5.9's default
	/// layout.
	pub zsh_fpath:   Option<Vec<BString>>,
	/// Whose shell it is: a user's, or a program's ([`Profile::Tool`]).
	pub profile:     Profile,
	/// bash sets `HOME` from the password database when the environment has
	/// none: a login shell by `argv[0]` outside posix mode
	/// ([`crate::bash::invocation::ShellArgs::login_home`]).
	pub login_home:  bool,
}

/// Whose shell a [`Shell`] is, which decides whether it may touch its
/// user's interactive state. Recorded at [`Shell::create`]
/// ([`MiscKey::Profile`]); nested shells (`bash -c`, `zsh -i`) inherit it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Profile {
	/// A user's own shell (`omp zsh`, obash): history, the line editor and
	/// the completion system work as in bash and zsh.
	#[default]
	User,
	/// A shell a program drives (an agent's `bash` tool, an embedder's
	/// session). It never reads, writes or records history (`fc -R/-W/-A`,
	/// `history -r/-w/-a/-n` fail on any history file; zsh's automatic
	/// load and save do not run), never edits lines on a terminal, has no
	/// completion system or key bindings (zsh/zle, zsh/complete,
	/// zsh/complist, zsh/computil, zsh/compctl, zsh/zleparameter and
	/// zsh/deltochar do not load, so `zle`, `bindkey`, `vared`, `compadd`, …
	/// fail; bash's `complete`, `compgen`, `compopt` and `bind` do not
	/// exist), and a nested interactive shell skips the interactive startup
	/// files (`~/.bashrc`, `$ENV`, `/etc/zshrc`, `.zshrc`) where completion
	/// and history are set up.
	Tool,
}

/// Whether `vp`'s shell was created with [`Profile::Tool`].
///
/// # Errors
/// [`StoreError`] when the record cannot be read.
pub fn is_tool(store: &mut dyn StateStore, vp: &Vproc) -> Result<bool, StoreError> {
	Ok(matches!(
		state::record(store, vp, Key::Misc(MiscKey::Profile))?,
		Some(Record::Misc(v)) if v.as_slice() == b"tool"
	))
}

impl Default for ShellInit {
	fn default() -> Self {
		Self {
			mode:        ModeId::Bash,
			argv0:       BString::from("bash"),
			args:        Vec::new(),
			env:         Vec::new(),
			cwd:         BString::from("/"),
			interactive: false,
			options:     Vec::new(),
			shell_pid:   0,
			startup:     Vec::new(),
			zsh_params:  Vec::new(),
			zsh_fpath:   None,
			profile:     Profile::User,
			login_home:  false,
		}
	}
}

/// A script to run ([`Shell::submit`]).
pub struct Script {
	/// Source bytes.
	pub source:           Arc<[u8]>,
	/// Where they came from (diagnostic prefixes, events).
	pub origin:           Origin,
	/// Mode to parse and run in; the vproc's mode before the run comes
	/// back when it ends (`None`: the shell's current mode, which an
	/// `emulate` in the script changes for later runs too).
	pub mode:             Option<ModeId>,
	/// Positional parameters for the script, replacing the inherited current
	/// positional scope in a new subshell without changing its caller.
	pub args:             Option<Vec<BString>>,
	/// Which virtual process runs it.
	pub vproc:            VprocSel,
	/// Opaque host tag, echoed in `RunStart`.
	pub tag:              u64,
	/// Working directory for the run.
	pub cwd:              Option<BString>,
	/// Exported variables for the run.
	pub env:              Vec<(BString, BString)>,
	/// Changes to inherited non-shell environment entries for a new subshell.
	/// A `None` name clears them; otherwise `None` removes and `Some` sets.
	pub foreign_env:      Vec<(Option<BString>, Option<BString>)>,
	/// Shell variable names whose inherited bindings must not be exported in
	/// the new subshell, including bindings hidden by local scopes.
	pub unexport_env:     Vec<BString>,
	/// On Unix, the host hears of an `exec` replacing the run's vproc that
	/// the system refuses because the command line is too long (`E2BIG`,
	/// `ENAMETOOLONG`, `ENOMEM`): the shell prints nothing for it, the run
	/// ends with status 126, and [`Shell::exec_refusal`] has the error. A
	/// callout can then retry with fewer arguments (`xargs`). A tool the run
	/// calls hears of it as well ([`ToolCall::too_long_to_caller`]) and hands
	/// such a refusal of its own command up the same way
	/// ([`CallOutcome::TooLong`]). Set it only for a script that runs nothing
	/// before that `exec` or tool (a callout's generated `exec` of a program,
	/// or its call of `timeout`, `nohup`, `env` or `ifne`, in a subshell with
	/// [`Script::as_program`]; the `exec` of the program `timeout` or `nohup`
	/// runs): a retry would run all of it again.
	pub too_long_to_host: bool,
	/// With [`Script::too_long_to_host`], the host hears of every other
	/// refusal of that `exec` too (`EACCES`, `ENOENT` of a `#!` interpreter,
	/// `ENAMETOOLONG` of a path), and of an `exec` that found nothing to run
	/// (`ENOENT`; `EACCES` for a directory), the same way: nothing printed,
	/// status 126 (127 for `ENOENT`), [`Shell::exec_refusal`] has the error.
	/// `ENOEXEC` is no refusal: the file runs as a script. Set it only for an
	/// `exec` whose host reports a command it cannot run in its own words:
	/// `env`'s callout, and the `exec` of the program `timeout` or `nohup`
	/// runs (coreutils' `failed to run command`).
	pub refusals_to_host: bool,
	/// The new subshell stands for a program the caller started (a callout
	/// running a utility's command), whose children never see the caller's
	/// shell-only state. It starts with none of the caller's functions (its
	/// exported ones reach programs in the environment, as `BASH_FUNC_`
	/// entries, and can no longer be called), aliases or DEBUG, ERR and
	/// RETURN traps (even under `functrace` or `errtrace`), with `xtrace`
	/// off and every builtin enabled. What the subshell defines or sets
	/// itself is its own, as in any shell: a function its command defines
	/// runs, a `trap` it sets fires.
	pub as_program:       bool,
}

impl Script {
	/// A command script (`-c` semantics) on the root vproc.
	pub fn command(source: impl Into<Arc<[u8]>>) -> Self {
		Self {
			source:           source.into(),
			origin:           Origin::Command,
			mode:             None,
			args:             None,
			vproc:            VprocSel::Root,
			tag:              0,
			cwd:              None,
			env:              Vec::new(),
			foreign_env:      Vec::new(),
			unexport_env:     Vec::new(),
			too_long_to_host: false,
			refusals_to_host: false,
			as_program:       false,
		}
	}
}

/// Virtual process selection of a [`Script`].
///
/// `Root` runs in the shell itself, after earlier root scripts: its changes
/// persist, and [`Script::cwd`] / [`Script::env`] / [`Script::args`] are
/// applied to the root state when the script starts (as `cd`, `export` and
/// `set --` would). The `NewSubshell*` forms run in a fresh vproc with a
/// copy-on-write view of the root state, concurrently with other vprocs;
/// `cwd`, `env` and `args` apply to that subshell only.
pub enum VprocSel {
	/// The root vproc.
	Root,
	/// A new subshell vproc sharing the root's fds.
	NewSubshell,
	/// A new subshell vproc with its own fds 0, 1, 2.
	NewSubshellWithStdio([RunStdio; 3]),
}

/// One standard stream of a `NewSubshellWithStdio` run.
pub enum RunStdio {
	/// The root's fd.
	Inherit,
	/// Closed.
	Closed,
	/// This host file (a stdin blob, an output capture). Lost on restore.
	File(Box<dyn File>),
}

/// How much work one [`Shell::step`] may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
	/// Ops (safepoints).
	pub max_ops: u32,
	/// Wall time, checked between scheduler turns.
	pub max_ns:  u64,
}

impl Default for Budget {
	/// 20 000 ops or 2 ms.
	fn default() -> Self {
		Self { max_ops: 20_000, max_ns: 2_000_000 }
	}
}

/// Why [`Shell::step`] returned.
#[derive(Debug)]
pub enum Step {
	/// A script finished (others may continue).
	Done {
		/// The script.
		run:    RunId,
		/// Its final status.
		status: i32,
	},
	/// Run a host callout; answer with [`Shell::complete`] (in any order).
	/// The store is up to date when this is returned.
	Call {
		/// Answer key.
		id:   CallId,
		/// What to run.
		call: ToolCall,
	},
	/// Every vproc waits (on a pipe, callout, task, external or pending fs
	/// op); await [`ControlHandle::poll_runnable`], then step again.
	Blocked,
	/// Paused by [`ControlHandle::pause`] or a `Verdict::Pause`; returned
	/// until [`ControlHandle::resume`].
	Paused,
	/// The drain requested by [`ControlHandle::request_suspend`] reached a
	/// global safepoint: [`Shell::externalize`] now captures a complete
	/// snapshot. Returned once; the next `step` continues normally.
	SuspendReady,
	/// Budget exhausted with runnable work left.
	Yield,
	/// Nothing submitted.
	Idle,
}

/// A host callout to run ([`Step::Call`]).
#[derive(Clone, Debug)]
pub struct ToolCall {
	/// From [`Resolved::Tool`](crate::bash::Resolved::Tool).
	pub tool:               ToolRef,
	/// Expanded argv.
	pub argv:               Vec<BString>,
	/// Calling vproc.
	pub vpid:               Vpid,
	/// Output tag of this execution.
	pub tag:                CmdTag,
	/// Working directory.
	pub cwd:                BString,
	/// fds 0, 1, 2 (also reachable by number through [`ShellApi`]).
	pub stdio:              [FdRef; 3],
	/// Further open fds.
	pub extra_fds:          Vec<(i32, FdRef)>,
	/// Environment.
	pub env:                EnvView,
	/// File-creation mask: the shell's `umask`.
	pub umask:              u32,
	/// The calling run was submitted with [`Script::too_long_to_host`]: a
	/// tool that has done nothing a retry would repeat when it runs its
	/// command (`timeout`, `nohup`; the extras `env` without `--env0-from`
	/// and `ifne`) answers [`CallOutcome::TooLong`] when the system
	/// refuses that command's line as too long, so the host that submitted
	/// the run retries with fewer arguments (`xargs`).
	pub too_long_to_caller: bool,
}

/// How a host callout ended.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CallOutcome {
	/// Exit status.
	Exit(i32),
	/// Killed by a (virtual) signal: status 128 + n.
	Signaled(Signal),
	/// Failed: printed as `name: line N: tool: msg`, status 1.
	Error(BString),
	/// For a call with [`ToolCall::too_long_to_caller`]: the system refused
	/// the tool's command as too long with this error (`E2BIG`,
	/// `ENAMETOOLONG`, `ENOMEM`). The calling run hears of it as of its own
	/// refused `exec`: status 126, nothing printed, and
	/// [`Shell::exec_refusal`] has the error.
	TooLong(i32),
}

/// An `exec` the system refused, that the run's host hears of instead of
/// a diagnostic ([`Shell::exec_refusal`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExecRefusal {
	/// The error (`errno`).
	pub errno:    i32,
	/// The command line is too long ([`Script::too_long_to_host`]: a
	/// utility retries it with fewer arguments), as against a command that
	/// cannot run ([`Script::refusals_to_host`]).
	pub too_long: bool,
}

/// One shell: transient execution state only (scheduler, vprocs, frames,
/// caches). Persistent state lives in the [`StateStore`]. `Send`; holds no
/// host references.
pub struct Shell {
	k:         Kernel,
	/// Boxed: a `Vproc` is ~650 bytes and the vector doubles, so idle
	/// subshells would pay up to twice that in spare capacity (target:
	/// ≤ 2,048 B per idle vproc back to back).
	#[expect(clippy::vec_box, reason = "slack capacity of 8-byte slots, not of whole vprocs")]
	procs:     Vec<Box<Vproc>>,
	rr:        usize,
	/// A slice cut short by the step budget or a control request: the vproc
	/// and the ops it has left. The next step continues it, so which vproc
	/// runs when depends only on op counts, never on where the host's steps,
	/// pauses or snapshots fall.
	slice:     Option<(Vpid, u32)>,
	/// Subshell vprocs that ended since the last orphan check: their
	/// children are orphans ([`EngineConfig::end_orphan_jobs`] only).
	///
	/// [`EngineConfig::end_orphan_jobs`]: crate::bash::EngineConfig::end_orphan_jobs
	gone:      Vec<Vpid>,
	/// Orphaned job trees still watched for in-engine work (see the
	/// `orphans` module); empty unless [`Self::gone`] ever had entries.
	orphans:   Vec<Vpid>,
	/// Builtins' asks to take in the exits already available, not answered
	/// yet ([`Kernel::ask_exits`], [`Self::take_in_exits`]). Imaged, as
	/// [`Self::slice`] is: the asker stays parked across a snapshot, and
	/// only the answer wakes it.
	taking_in: Vec<TakeIn>,
	/// Vprocs adopted that have not had a turn yet: a take-in owes none of
	/// the asker's own such jobs a turn ([`Self::take_in_exits`]). Imaged
	/// with [`Self::taking_in`].
	fresh:     Vec<Vpid>,
}

/// One builtin's ask to take in the exits already available
/// ([`Kernel::ask_exits`]), until the scheduler answers it
/// ([`Shell::take_in_exits`]). Every vproc keeps its place in the
/// round-robin; nothing runs out of turn.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct TakeIn {
	/// The vproc whose builtin asked.
	asker: Vpid,
	/// The vprocs that had work when it asked, but for the asker's own jobs
	/// that had not had a turn yet.
	seen:  Vec<Vpid>,
	/// The turns still owed before the answer: each vproc of `seen` once,
	/// and once more the parent of each of them that ended since (it takes
	/// that end in).
	owed:  Vec<Vpid>,
}

/// The shell's `$SECONDS` clock as `MiscKey::StartNs` keeps it: the start
/// in host clock ns, then `:` and bash's assigned value when it is not 0,
/// then `:plain` once `unset SECONDS` removed its special meaning (`123`,
/// `123:5`, `123:0:plain`), so a record no `SECONDS=` in bash code changed
/// is the plain number it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartRecord {
	pub start:   u64,
	pub seconds: i64,
	pub plain:   bool,
}

impl std::fmt::Display for StartRecord {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match (self.seconds, self.plain) {
			(0, false) => write!(f, "{}", self.start),
			(s, false) => write!(f, "{}:{s}", self.start),
			(s, true) => write!(f, "{}:{s}:plain", self.start),
		}
	}
}

impl std::str::FromStr for StartRecord {
	type Err = std::num::ParseIntError;

	fn from_str(s: &str) -> Result<Self, Self::Err> {
		let mut parts = s.splitn(3, ':');
		let start = parts.next().unwrap_or_default().parse()?;
		let seconds = parts.next().map_or(Ok(0), str::parse)?;
		Ok(Self { start, seconds, plain: parts.next() == Some("plain") })
	}
}

/// The arithmetic results of one argument of a builtin that runs again
/// ([`Kernel::arith_replay`]).
#[derive(Debug, Default)]
pub struct ArithReplay {
	/// Each result in the order the argument evaluated them.
	pub values: Vec<i64>,
	/// The next result to take.
	pub next:   usize,
	/// An evaluation is under way: arithmetic it runs inside (a variable's
	/// value evaluated as an expression) is its own, not one to take.
	pub inside: bool,
}

/// Shell-wide state shared by all vprocs (kept apart from `procs` so ops can
/// borrow a vproc and the kernel at once).
pub struct Kernel {
	pub engine:             Arc<Engine>,
	pub ctl:                Arc<Ctl>,
	pub waker:              Waker,
	/// Facts derived from the root state in the store (the state itself
	/// lives in the store).
	pub root:               Root,
	pub mask:               EventMask,
	pub seq:                u64,
	pub next_vpid:          u32,
	pub next_run:           u64,
	pub next_call:          u64,
	pub next_cmd:           u64,
	pub next_job:           u32,
	pub done:               VecDeque<(RunId, i32)>,
	pub calls_out:          VecDeque<(CallId, ToolCall)>,
	pub results:            HashMap<CallId, CallOutcome>,
	/// Units announced by each vproc to the current observer. A prior
	/// background vproc's rejected events must not suppress current units.
	/// Not imaged: restored/cached frames announce lazily when executed.
	pub announced:          HashSet<(Vpid, UnitId, Option<crate::bash::event::SourceOrigin>)>,
	/// Observed script origins by actual activation depth. Empty without
	/// tracing.
	pub trace_sources:      HashMap<Vpid, HashMap<usize, crate::bash::event::SourceOrigin>>,
	/// Origin of each currently executing source-context unit in its actual
	/// vproc.
	pub trace_unit_origins: HashMap<Vpid, Arc<HashMap<UnitId, crate::bash::event::SourceOrigin>>>,
	/// Unit blobs known to be in the store ([`Kernel::note_written`]); at
	/// most [`WRITTEN_MAX`] ids.
	pub written:            HashSet<UnitId, crate::bash::ids::UnitIdState>,
	/// Reused buffer for encoding unit blobs ([`Kernel::persist_unit`]); not
	/// imaged.
	blob_buf:               Vec<u8>,
	/// The `next_vpid` value last written as `MiscKey::NextVpid`
	/// ([`Kernel::vpid`], [`Kernel::sync_root`]).
	pub written_vpid:       u32,
	pub paused:             bool,
	pub argv0:              BString,
	pub shell_pid:          u32,
	/// Idempotent fs ops dropped by the last suspend (re-issued on resume).
	pub dropped_fs:         u32,
	/// Child vprocs created during a turn, adopted by the scheduler after it.
	/// Every child vproc has a `Record::Proc` from its adoption until its
	/// exit status is collected ([`Kernel::proc_exited`],
	/// [`Kernel::proc_collect`]). Boxed as `Shell::procs` holds them:
	/// adoption moves pointers, and the capacity a burst leaves behind is 8
	/// bytes a slot, not a whole vproc (`cmd &` in a loop spawns ~200 per
	/// slice: that kept ~600 bytes per idle vproc; the target is ≤ 2,048 B back
	/// to back).
	#[expect(clippy::vec_box, reason = "slack capacity of 8-byte slots, not of whole vprocs")]
	pub spawned:            Vec<Box<Vproc>>,
	/// The records an asynchronous command's signal ignores
	/// (`exec::ignore_async_signals`) last turned which (mode, records)
	/// into: the next one forked from the same records shares them. Held
	/// weakly, so neither the root's records nor an exited job's stay
	/// shared through it.
	pub async_ignored:      Option<(ModeId, Records, Records)>,
	/// Subshells the host submitted to the root since the last turn (no
	/// store at hand): `adopt` gives each the root's state then, with its
	/// script's changes.
	pending_forks:          Vec<(Vpid, ForkEdits)>,
	/// The shell's `$RANDOM` generator state (written through as
	/// `MiscKey::Random` by [`Kernel::next_random`] and
	/// [`Kernel::seed_random`]); a forked vproc draws from its own copy
	/// ([`proc::Clock`]).
	pub rand:               state::Random,
	/// `unset RANDOM` or an array assignment in bash code removed the
	/// special meaning of the shell's `RANDOM`: it is a plain variable from
	/// then on (kept in `MiscKey::Random`, [`state::random_record`]); a
	/// forked vproc has its own ([`proc::Clock`]).
	pub random_plain:       bool,
	/// The host clock reading of the shell's start or of its last `SECONDS=`
	/// in bash code (bash's `shellstart`; `MiscKey::StartNs`); a forked
	/// vproc has its own ([`proc::Clock`], [`Kernel::start_of`]).
	pub start_ns:           u64,
	/// The shell's last `SECONDS=` value in bash code (bash's
	/// `seconds_value_assigned`), which `$SECONDS` adds to the seconds since
	/// `start_ns` (kept in `MiscKey::StartNs` with it, [`StartRecord`]).
	pub seconds:            i64,
	/// `unset SECONDS` or an array assignment in bash code removed the
	/// special meaning of the shell's `SECONDS`: it is a plain variable from
	/// then on (kept in `MiscKey::StartNs`, [`StartRecord`]); a forked vproc
	/// has its own ([`proc::Clock`]).
	pub seconds_plain:      bool,
	/// `unset` in bash code removed these value cells of the shell (bits of
	/// `dynvars::CELLS` indices): plain variables from then on (kept in
	/// `MiscKey::CellsPlain`); a forked vproc has its own ([`proc::Clock`]).
	pub cells_plain:        u16,
	/// Redirections bash makes in a child are being applied (a subshell's
	/// own, a forked simple command's: [`redir::apply_in_child`]): bash
	/// expands them in the child, after the fork, so each expansion pass of
	/// their words runs on that child's state, which the command's words
	/// share ([`redir::ChildState`]), and a lookup of the special `RANDOM`
	/// or `SECONDS` there leaves the shell's value cell alone
	/// ([`dynvars::store_value`]). Set only during that call, which restores
	/// it before it returns; not imaged.
	pub redirs_in_child:    bool,
	/// The virtual pid a `$BASHPID` reads during an expansion pass on that
	/// child's state ([`redir::enter_child`]): bash makes those redirections
	/// in the command's child, so `$BASHPID` there is the child's, not the
	/// shell's. The next free vpid, peeked, not taken; set only for the
	/// pass, which restores it; not imaged.
	pub redirs_child_pid:   Option<Vpid>,
	/// The arithmetic results a builtin's argument evaluates while
	/// [`builtins::Ctx::arith_once`] runs ([`expand::arith_value`]): taken
	/// in order on a run again after a later argument's `$(…)` or a probe,
	/// logged on the first run. Set only during that call; not imaged (the
	/// replay log holds the results).
	pub arith_replay:       Option<ArithReplay>,
	/// Startup files (`path`, contents) the root vproc sources when its
	/// first run starts ([`ShellInit::startup`]); not imaged (the first run
	/// starts at the first step).
	pub startup:            Vec<(BString, BString)>,
	/// Which DEBUG/ERR/RETURN traps may be set: lets `exec::start_trap`
	/// skip its checks before every command; not imaged.
	pub pseudo_traps:       exec::PseudoTraps,
	/// bash's `INT` as each vproc that has one has it ([`IntNote`]): where its
	/// last wait began, or noted while it waits for its foreground job or reads
	/// a command substitution. Kept here, not on the vproc, which stays in its
	/// size budget; an entry goes when its vproc ends. Not imaged: a snapshot
	/// drops a wait in flight.
	pub int_notes:          Vec<(Vpid, IntNote)>,
	/// The subshell vprocs that die of a signal, not reaped yet, with the
	/// signal: by their own end at its default action (`Shell`'s `kill`), as
	/// the program they are ([`external_ended`]), as the one `( … )` they
	/// wait for ([`Shell::reaped`]: one process in bash), or through their
	/// own EXIT trap (bash `termsig_handler` kills the subshell with the
	/// signal once the trap has run). Their parent reads it at the reap
	/// ([`Shell::reaped`]): a hold of `INT` for its foreground job, and the
	/// job of a background one (bash `WIFSIGNALED`). Apart from
	/// [`Self::int_notes`]: a wait the EXIT trap begins rewrites those. In
	/// the frames image: a snapshot between the death and the reap keeps it.
	pub deaths:             Vec<(Vpid, Signal)>,
	/// Notices of foreground subshells a signal killed
	/// ([`killed::subshell_ended`]) held until the `( … )`'s own
	/// redirections are undone: the vproc, the depth of its frame, the
	/// notice. An entry goes when its vproc ends. In the frames image.
	pub held_notices:       Vec<(Vpid, u32, BString)>,
	/// The vprocs whose pending `INT` trap bash runs with the job list
	/// frozen ([`proc::ScriptKind::Trap`]'s `frozen`): the `INT` came while
	/// the vproc waited for a forked foreground command (bash's `wait_for`
	/// runs the trap). Kept here, not on the vproc, which stays in its size
	/// budget; an entry goes when the trap starts or its vproc ends. Not
	/// imaged: a snapshot drops the wait in flight.
	pub frozen_ints:        Vec<Vpid>,
	/// Signals sent to the shell while the program the root runs in place
	/// of itself (`exec`, [`proc::ExecState::in_place`]) was still being
	/// spawned: the program gets them once it exists (a spawn that fails
	/// drops them). Not imaged: a snapshot drops a spawn in flight.
	pub forward:            crate::bash::SigSet,
	/// The root's process runs a program in place of the shell (`exec`, or
	/// the last command of a `-c` string, in the root or a zsh `( … )` run in
	/// place): each signal whose default action ends the process is caught
	/// for it and forwarded ([`untrapped::program_in_place`]). Not imaged.
	pub program_in_place:   bool,
	/// The jump the running op makes comes after bash's `top_level_cleanup`
	/// ([`exec::jump_out`]); the arm that takes the op's flow reads and
	/// clears it. Not imaged: set and read within one op.
	pub top_level_cleanup:  bool,
	/// Re-parsed `${ ;}` bodies ([`exec::NoforkUnits`]); not imaged.
	pub nofork_units:       exec::NoforkUnits,
	/// The functions each zsh word code digest (`.zwc`) holds, by path,
	/// with the modification time and size they were read at
	/// ([`Kernel::dump_funcs`]): an `$fpath` search asks of the same digests
	/// for every function it resolves. Per shell, as its host's files are
	/// (shells sharing an engine may see other files at a path); not imaged.
	zsh_dumps:              parking_lot::Mutex<HashMap<BString, DumpFuncs>>,
	/// Syntax-tree buffers of the last command run, lent to the next parse
	/// ([`Parser::recycle`](crate::bash::syntax::Parser::recycle); at most
	/// [`SPARE_BUFFER_BYTES`], see [`Kernel::keep_spare_tree`]); not imaged.
	pub spare_tree:         crate::bash::syntax::Tree,
	/// The arithmetic this shell evaluated last ([`arith::Recent`]); not
	/// imaged.
	pub arith_recent:       arith::Recent,
	/// [`arith_recent`](Self::arith_recent) for zsh's evaluator.
	pub zsh_arith_recent:   zsh::math::Recent,
	/// The last event clock reading while it is still current
	/// ([`Kernel::stamp`]): set by a reading that ends a duration or starts a
	/// command, cleared by [`Kernel::clock_stale`] before anything that can
	/// take time (a vproc's turn, an op other than control flow, I/O,
	/// parsing, a builtin). Lets the `CmdStart`, `CmdExpanded` and
	/// `FuncEnter` events of a command (and a function's `FuncExit`) share
	/// one `Host::now_ns` with the previous `CmdEnd` (xeon overhead profile:
	/// `now_ns` a third of the default-mask event cost). Not imaged.
	pub clock:              Option<u64>,
	/// The empty document an async command without job control reads as
	/// `/dev/null`, shared by all of them (it never yields a byte, so one
	/// object serves every reader): an fd object and two buffers less per
	/// background vproc (idle vproc ≤ 2,048 B back to back). Not imaged (a
	/// restored child keeps its own object).
	pub null_input:         Option<FdRef>,
	/// `(label, caller)`: the labeled subshell trees host callouts started
	/// ([`ShellApi::run_subshell_in`]) and the vproc that ran each callout;
	/// virtual signals to the caller reach the tree (`Shell::deliver`).
	/// Pruned there once no vproc carries the label; not imaged (callouts
	/// do not survive a restore).
	pub callout_labels:     Vec<(u32, Vpid)>,
	/// The root's background jobs (their vpids) as its current script
	/// started: an earlier script's work, which a cancel of this one spares
	/// (`Shell::apply_requests`). Set at every root run start; not imaged.
	pub prior_jobs:         Vec<Vpid>,
	/// The last root run that `exit` or `set -e` ended
	/// ([`Shell::ended_by_exit`]); not imaged.
	pub exited:             Option<RunId>,
	/// Signal deaths of external programs replacing a submitted run, pending
	/// its completion report; callouts do not survive frame restoration.
	pub exec_signals:       HashMap<RunId, i32>,
	/// Signal death associated with the most recently reported run.
	pub reported_signal:    Option<(RunId, i32)>,
	/// `exec`s the system refused, replacing a run submitted with
	/// [`Script::too_long_to_host`], pending its completion report; not
	/// imaged, like `exec_signals`.
	pub exec_refusals:      HashMap<RunId, ExecRefusal>,
	/// Refusal associated with the most recently reported run.
	pub reported_refusal:   Option<(RunId, ExecRefusal)>,
	/// The signal the root shell died of ([`Shell::killed_by`]); not imaged.
	pub killed_by:          Option<i32>,
	/// Background jobs whose pid is still to be settled
	/// ([`proc::Bang`]): imaged (a restored job still decides).
	pub bangs:              Vec<proc::Bang>,
	/// `extdebug`: pipeline stages a failing DEBUG trap skips, waiting for
	/// their `Spawn` ([`proc::DebugSkip`]), one list per vproc and frame:
	/// imaged (a snapshot can fall between two stages' traps). A list whose
	/// `Spawn` never ran (a trap `return`ed) is dropped when a `Spawn` at
	/// that frame or above next runs its stage traps (also with the trap
	/// gone: the pseudo-trap check stays set once a DEBUG trap was).
	pub debug_skips:        Vec<proc::DebugSkip>,
	/// `(job, ops)`: the ops what decides a background job's pid has run
	/// since a reader of the pid parked ([`Shell::decide_waited_bangs`]);
	/// dropped when the job settles. Not imaged: a restored shell gives a
	/// waited job a new slice.
	pub bang_spent:         Vec<(Vpid, u32)>,
	/// `(child, vproc)`: an in-engine child the vproc that decides a job's
	/// pid waits for (a command substitution, a subshell, a pipeline
	/// stage), transitively ([`Kernel::bang_kin_add`]). A program such a
	/// child runs is one the job waits for: the job keeps its virtual pid
	/// when it starts. Dropped when the job settles; not imaged (a vpid is
	/// never reused).
	pub bang_kin:           Vec<(Vpid, Vpid)>,
	/// `(vproc, OS pid)`: jobs settled on their program's OS pid during the
	/// turn, and pipeline stages that are just the program they spawned
	/// ([`stage_spawned`]), written into the job tables and `$!` of every
	/// vproc, and into the records of the processes of a job and of a
	/// pipeline a vproc waits for ([`proc::JobProc`]), by the scheduler after
	/// it (`Shell::adopt`); empty between turns, not imaged.
	pub settled:            Vec<(Vpid, u32)>,
	/// `(OS pid, vproc, job)`: a job's `$!` names a program a vproc other
	/// than the job's own runs (a background pipeline's last stage), so
	/// `kill` of that pid signals that vproc, and finds no process once it
	/// ended though the job runs on. Dropped when the job ends; not imaged
	/// (a restored shell signals the job's vproc).
	pub pid_owners:         Vec<(u32, Vpid, Vpid)>,
	/// Vprocs whose builtin is about to report job state and asked first to
	/// take in the exits already available ([`Kernel::ask_exits`]). Each
	/// stays here until the scheduler answers it after a turn
	/// (`Shell::take_in_exits`) or its builtin goes on without the answer
	/// ([`Kernel::withdraw_exits`]). Imaged: the asker stays parked across a
	/// snapshot.
	pub exits_asked:        Vec<Vpid>,
	/// Vprocs whose ask the scheduler answered: their builtin, run again,
	/// reports now ([`Kernel::exits_taken`]). Imaged.
	pub exits_taken:        Vec<Vpid>,
	/// Jobs `disown` dropped before the scheduler adopted them: their
	/// record names no parent (`Shell::adopt`, [`Kernel::disown`]). Empty
	/// between turns; not imaged.
	pub disowned:           Vec<Vpid>,
	/// The math options ([`zsh::arith::math_options`]) last read for a vproc
	/// without an image (the root), with the [`state::Root::opts_gen`] and mode
	/// they were read under: every `(( ))` asks.
	pub math_opts:          Option<(u64, ModeId, zsh::math::Options)>,
	/// Background jobs' lone commands whose redirections wait for their name
	/// to resolve ([`proc::Deferral`]): imaged (a restored command goes on).
	pub deferrals:          Vec<proc::Deferral>,
	/// The externals that give background jobs their `$!` whose program
	/// was busy ([`proc::BusySpawn`]), by deciding vproc; not imaged (a
	/// restored spawn meets the busy program again).
	pub busy:               Vec<(Vpid, proc::BusySpawn)>,
	/// `(job vproc, stage vpids)`: the vpids of the processes of a background
	/// pipeline job ([`proc::Job::procs`]), reserved as the job starts (bash
	/// forks each stage then), which that vproc's pipeline gives its stages
	/// as it starts them ([`Self::take_stage_vpids`]). Dropped when the vproc
	/// ends; imaged (a restored job still starts its stages).
	pub stage_vpids:        Vec<(Vpid, Vec<Vpid>)>,
	/// Job control of the interactive shell (process groups, the
	/// terminal, stop events); not imaged.
	pub jobctl:             jobctl::JobCtl,
}

/// A child vproc's entry in the process table ([`Kernel::proc_state`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcState {
	/// Still running.
	Running,
	/// Finished with this status; not collected yet.
	Exited(i32),
}

impl ProcState {
	/// The exit status once finished.
	pub const fn exited(self) -> Option<i32> {
		match self {
			Self::Running => None,
			Self::Exited(status) => Some(status),
		}
	}
}

/// A digest's function names, with the modification time (ns) and size
/// of the file they were read from.
type DumpFuncs = ((i64, u64), Arc<std::collections::HashSet<BString>>);

impl Kernel {
	/// Vproc `vpid`'s [`IntNote`].
	pub(super) fn int_note(&self, vpid: Vpid) -> Option<IntNote> {
		self
			.int_notes
			.iter()
			.find(|(v, _)| *v == vpid)
			.map(|&(_, note)| note)
	}

	/// Set vproc `vpid`'s [`IntNote`] (`None`: drop it).
	pub(super) fn set_int_note(&mut self, vpid: Vpid, note: Option<IntNote>) {
		let at = self.int_notes.iter().position(|(v, _)| *v == vpid);
		match (at, note) {
			(Some(i), Some(note)) => self.int_notes[i].1 = note,
			(Some(i), None) => {
				self.int_notes.swap_remove(i);
			},
			(None, Some(note)) => self.int_notes.push((vpid, note)),
			(None, None) => {},
		}
	}

	/// Subshell vproc `vpid` dies of `sig` ([`Self::deaths`]): of the last
	/// signal that ends it.
	pub(super) fn dies_of(&mut self, vpid: Vpid, sig: Signal) {
		match self.deaths.iter_mut().find(|(v, _)| *v == vpid) {
			Some(death) => death.1 = sig,
			None => self.deaths.push((vpid, sig)),
		}
	}

	/// The signal vproc `vpid` died of ([`Self::deaths`]), if any; its entry
	/// goes.
	pub(super) fn died_of(&mut self, vpid: Vpid) -> Option<Signal> {
		let at = self.deaths.iter().position(|(v, _)| *v == vpid)?;
		Some(self.deaths.swap_remove(at).1)
	}

	/// The functions (metafied names) of the digest `path` as this shell
	/// last read it, while its modification time and size are `stamp`.
	pub(crate) fn dump_funcs(
		&self,
		path: &[u8],
		stamp: (i64, u64),
	) -> Option<Arc<std::collections::HashSet<BString>>> {
		self
			.zsh_dumps
			.lock()
			.get(path)
			.filter(|(s, _)| *s == stamp)
			.map(|(_, f)| Arc::clone(f))
	}

	/// Remember the functions `funcs` of the digest `path` at `stamp`.
	pub(crate) fn cache_dump_funcs(
		&self,
		path: &[u8],
		stamp: (i64, u64),
		funcs: Arc<std::collections::HashSet<BString>>,
	) {
		self
			.zsh_dumps
			.lock()
			.insert(BString::from(path), (stamp, funcs));
	}

	fn new(engine: &Arc<Engine>, mut root: Root, argv0: BString, shell_pid: u32) -> Self {
		root.set_platform(engine.config().platform);
		let ctl = Ctl::new();
		Self {
			engine: Arc::clone(engine),
			waker: control::engine_waker(&ctl),
			ctl,
			root,
			mask: EventMask::DEFAULT,
			seq: 0,
			next_vpid: engine.config().vpid_base,
			next_run: 1,
			next_call: 1,
			next_cmd: 1,
			next_job: 1,
			done: VecDeque::new(),
			calls_out: VecDeque::new(),
			results: HashMap::new(),
			announced: HashSet::new(),
			trace_sources: HashMap::new(),
			trace_unit_origins: HashMap::new(),
			written: HashSet::default(),
			blob_buf: Vec::new(),
			written_vpid: engine.config().vpid_base,
			paused: false,
			argv0,
			shell_pid,
			dropped_fs: 0,
			spawned: Vec::new(),
			pending_forks: Vec::new(),
			async_ignored: None,
			rand: state::Random::new(1),
			random_plain: false,
			start_ns: 0,
			seconds: 0,
			seconds_plain: false,
			cells_plain: 0,
			redirs_in_child: false,
			redirs_child_pid: None,
			arith_replay: None,
			startup: Vec::new(),
			pseudo_traps: exec::PseudoTraps::default(),
			int_notes: Vec::new(),
			deaths: Vec::new(),
			held_notices: Vec::new(),
			frozen_ints: Vec::new(),
			forward: crate::bash::SigSet::EMPTY,
			program_in_place: false,
			top_level_cleanup: false,
			nofork_units: HashMap::new(),
			zsh_dumps: parking_lot::Mutex::new(HashMap::new()),
			spare_tree: crate::bash::syntax::Tree::default(),
			arith_recent: arith::Recent::default(),
			zsh_arith_recent: zsh::math::Recent::default(),
			clock: None,
			null_input: None,
			callout_labels: Vec::new(),
			prior_jobs: Vec::new(),
			exited: None,
			exec_signals: HashMap::new(),
			reported_signal: None,
			exec_refusals: HashMap::new(),
			reported_refusal: None,
			killed_by: None,
			bangs: Vec::new(),
			debug_skips: Vec::new(),
			bang_spent: Vec::new(),
			bang_kin: Vec::new(),
			settled: Vec::new(),
			pid_owners: Vec::new(),
			exits_asked: Vec::new(),
			exits_taken: Vec::new(),
			disowned: Vec::new(),
			math_opts: None,
			deferrals: Vec::new(),
			busy: Vec::new(),
			stage_vpids: Vec::new(),
			jobctl: jobctl::JobCtl::default(),
		}
	}

	/// Record the root's background jobs as earlier scripts' work
	/// ([`Kernel::prior_jobs`]), as a root script is about to start.
	pub fn note_prior_jobs(&mut self, root: &Vproc) {
		self.prior_jobs.clear();
		self.prior_jobs.extend(root.jobs.iter().map(|job| job.vpid));
	}

	/// The redirections `vproc`'s command leaves to the process it spawns,
	/// while it decides ([`proc::Deferral`]).
	pub fn deferral(&mut self, vproc: Vpid) -> Option<&mut proc::Deferral> {
		self.deferrals.iter_mut().find(|d| d.vproc == vproc)
	}

	/// `vproc` ended, or its command did: forget what it was deciding.
	pub fn forget_deferral(&mut self, vproc: Vpid) {
		if !self.deferrals.is_empty() {
			self.deferrals.retain(|d| d.vproc != vproc);
		}
	}

	/// `vpid`'s builtin is about to report job state: the scheduler first
	/// takes in the exits already available ([`Kernel::exits_asked`]), then
	/// the builtin runs again.
	pub fn ask_exits(&mut self, vpid: Vpid) {
		if !self.exits_asked.contains(&vpid) {
			self.exits_asked.push(vpid);
		}
	}

	/// Whether the scheduler answered `vpid`'s [`Kernel::ask_exits`]; the
	/// answer is used up.
	pub fn exits_taken(&mut self, vpid: Vpid) -> bool {
		let Some(i) = self.exits_taken.iter().position(|&v| v == vpid) else {
			return false;
		};
		self.exits_taken.swap_remove(i);
		true
	}

	/// Whether `vpid`'s take-in ask has been answered ([`Self::exits_taken`])
	/// without consuming the answer, unlike [`Self::exits_taken`]: a check
	/// before a builtin runs (`command::exec` takes a take-in builtin's exits
	/// in before its redirections, so a snapshot during the wait strands no
	/// redirect to a host file).
	pub fn took_exits(&self, vpid: Vpid) -> bool {
		self.exits_taken.contains(&vpid)
	}

	/// `vpid`'s builtin goes on without the answer to its ask: every job of
	/// its vproc ended before the answer came (a parked asker runs again at
	/// each wake), so nothing is left to take in, and it asks no more.
	pub fn withdraw_exits(&mut self, vpid: Vpid) {
		self.exits_asked.retain(|&v| v != vpid);
	}

	/// Whether `vpid`'s builtin asked to take in exits and has not run again
	/// since its answer ([`Kernel::exits_asked`], [`Kernel::exits_taken`]):
	/// its command is still running, with that command's redirections.
	pub fn asking(&self, vpid: Vpid) -> bool {
		self.exits_asked.contains(&vpid) || self.exits_taken.contains(&vpid)
	}

	/// `disown` dropped the job whose vproc is `vpid`: it is no child of the
	/// shell for `wait` any more (bash deletes the job; `wait` neither waits
	/// for it nor finds it, unless by the status bash keeps), so its record
	/// names no parent ([`Self::started`] is false) and keeps doing so once it
	/// ends ([`Self::proc_exited`]); `kill` still finds the process while it
	/// runs. It is still the shell's child for its end: bash's `waitchld`
	/// counts every child it reaps, so the end owes a `SIGCHLD` trap run as
	/// any child's does (`Shell::reaped` takes the vproc's parent).
	pub fn disown(&mut self, store: &mut dyn StateStore, vpid: Vpid) {
		if self.spawned.iter().any(|p| p.vpid == vpid) {
			self.disowned.push(vpid);
			return;
		}
		if let Ok(Some(&Record::Proc { status, .. })) = store.get(Key::Proc(vpid)) {
			let rec = Record::Proc { parent: None, status };
			self.root.write(store, Change::Put(Key::Proc(vpid), rec));
		}
	}

	/// The pid of background job `job` is still to be settled
	/// ([`proc::Bang`]): readers of it wait (`WaitKey::Proc(job)`), and
	/// `kill` leaves its signal for the decision ([`Self::hold_signal`]).
	pub fn bang_pending(&self, job: Vpid) -> bool {
		self.bangs.iter().any(|b| b.job == job)
	}

	/// Whether vproc `vproc` decides a background job's pid
	/// ([`proc::Bang`]) for which `kill` holds signals
	/// ([`Self::hold_signal`]).
	pub fn holds(&self, vproc: Vpid) -> bool {
		self
			.bangs
			.iter()
			.any(|b| b.vproc == vproc && b.held != crate::bash::SigSet::EMPTY)
	}

	/// Vproc `vproc`, still deciding a job's pid ([`proc::Bang`]), acts
	/// with no program (it reports an error, or ends): if `kill` held
	/// signals for the job ([`Self::holds`]), the job is known by its
	/// virtual pid and they go first ([`Self::settle_bang`]). Whether they
	/// did: the caller returns `Flow::Block(WaitKey::Signal)`, and its op
	/// runs again after them.
	pub fn take_held(&mut self, vproc: Vpid) -> bool {
		self.holds(vproc) && self.settle_bang(vproc, None)
	}

	/// `kill` sends `sig` to background job `job` while its pid is still to
	/// be settled ([`Self::bang_pending`]): the signal waits for the decision
	/// ([`proc::Bang::held`]), and `kill` does not. A stop discards a held
	/// `CONT`, and a `CONT` the held stops, as the kernel does for the
	/// signals pending on a process.
	pub fn hold_signal(&mut self, job: Vpid, sig: Signal) {
		let Some(bang) = self.bangs.iter_mut().find(|b| b.job == job) else {
			return;
		};
		let mut held = bang.held;
		match sig.default_action() {
			DefaultAction::Stop => held = held.without(Signal::Cont),
			DefaultAction::Continue => {
				for stop in [Signal::Stop, Signal::Tstp, Signal::Ttin, Signal::Ttou] {
					held = held.without(stop);
				}
			},
			_ => {},
		}
		bang.held = held.with(sig);
	}

	/// Settle the job vproc `vproc` decides ([`proc::Bang`]): known by the
	/// OS pid `os`, or by its virtual pid (`None`). Wakes the readers. The
	/// signals `kill` held for the job ([`Self::hold_signal`]) go on the
	/// bus to the deciding vproc and what it runs, which take them at the
	/// next safepoint: the program `os` names gets them, or, with no
	/// program, the vproc before it runs its command. Whether there were
	/// any: a caller about to run that command returns
	/// `Flow::Block(WaitKey::Signal)` then, and its op runs again after them
	/// (as for a signal that comes before a spawn).
	pub fn settle_bang(&mut self, vproc: Vpid, os: Option<u32>) -> bool {
		if !self.busy.is_empty() {
			self.busy.retain(|(v, _)| *v != vproc);
		}
		let Some(i) = self.bangs.iter().position(|b| b.vproc == vproc) else {
			return false;
		};
		let bang = self.bangs.swap_remove(i);
		if !self.bang_spent.is_empty() {
			self.bang_spent.retain(|&(job, _)| job != bang.job);
		}
		if self.bangs.is_empty() {
			// Also the children of a vproc a job's decision moved from
			// (`exec::retarget_bang`).
			self.bang_kin.clear();
		} else if !self.bang_kin.is_empty() {
			self.bang_kin.retain(|&(_, decider)| decider != bang.vproc);
		}
		if let Some(pid) = os {
			self.settled.push((bang.job, pid));
			if bang.vproc != bang.job {
				self.pid_owners.push((pid, bang.vproc, bang.job));
			}
		}
		jobctl::bang_settled(self, bang.vproc, os);
		self.ctl.notify();
		for sig in bang.held.iter() {
			ControlHandle(self.ctl.clone()).signal(SigTarget::Tree(bang.vproc), sig);
		}
		bang.held != crate::bash::SigSet::EMPTY
	}

	/// The vpids reserved for the stages of the pipeline that is job vproc
	/// `job`'s whole command ([`Self::stage_vpids`]), taken as it starts
	/// them; none for any other vproc.
	pub fn take_stage_vpids(&mut self, job: Vpid) -> Vec<Vpid> {
		match self.stage_vpids.iter().position(|(j, _)| *j == job) {
			Some(i) => self.stage_vpids.swap_remove(i).1,
			None => Vec::new(),
		}
	}

	/// `parent` started `child`, an in-engine child it waits for (a command
	/// substitution, a subshell, a pipeline stage): when `parent` decides a
	/// job's pid, or is such a child of the vproc that does, so is `child`
	/// ([`Kernel::bang_kin`]).
	pub fn bang_kin_add(&mut self, parent: Vpid, child: Vpid) {
		if self.bangs.is_empty() {
			return;
		}
		let decider = if self.bangs.iter().any(|b| b.vproc == parent) {
			Some(parent)
		} else {
			self
				.bang_kin
				.iter()
				.find(|&&(c, _)| c == parent)
				.map(|&(_, d)| d)
		};
		if let Some(decider) = decider {
			self.bang_kin.push((child, decider));
		}
	}

	/// The copy of `p`'s `$RANDOM` generator and `$SECONDS` clock a fork
	/// gives its child, with whether `unset` removed their special meaning:
	/// bash code reseeds the generator on the child's first `$RANDOM`
	/// unless the child assigns `RANDOM` first.
	pub fn fork_clock(&self, p: &Vproc) -> proc::Clock {
		proc::Clock {
			rand:          p.clock.map_or(self.rand, |c| c.rand),
			reseed:        true,
			start_ns:      self.start_of(p),
			seconds:       p.clock.map_or(self.seconds, |c| c.seconds),
			seconds_plain: self.plain(p, dynvars::Special::Seconds),
			random_plain:  self.plain(p, dynvars::Special::Random),
			cells_plain:   p.clock.map_or(self.cells_plain, |c| c.cells_plain),
		}
	}

	/// Next `$RANDOM` (0..=32767) of `vp`. A forked vproc draws from its own
	/// generator ([`proc::Clock`]), which bash code reseeds on the first
	/// draw unless `RANDOM` was assigned (bash `get_random_number`'s
	/// `seeded_subshell`) and zsh code draws on from its parent's; the
	/// shell's own is written through.
	pub fn next_random(&mut self, cx: &mut Cx<'_>, vp: &mut Vproc) -> u32 {
		let bash = vp.mode.dialect() == crate::bash::ids::Dialect::Bash;
		if let Some(clock) = vp.clock.as_mut() {
			if clock.reseed && bash {
				clock.rand = state::Random::new((cx.host.random() & 0xffff_ffff) as u32);
				clock.reseed = false;
			}
			return clock.rand.next();
		}
		let v = self.rand.next();
		self.write_random(cx.store);
		v
	}

	/// `RANDOM=seed` in `vp`: its own generator when forked (no reseed
	/// follows), else the shell's, written through.
	pub fn seed_random(&mut self, store: &mut dyn StateStore, vp: &mut Vproc, seed: i64) {
		if let Some(clock) = vp.clock.as_mut() {
			clock.rand.seed(seed);
			clock.reseed = false;
			return;
		}
		self.rand.seed(seed);
		self.write_random(store);
	}

	/// The shell's generator record ([`state::random_record`]).
	pub fn write_random(&mut self, store: &mut dyn StateStore) {
		self.root.set_misc(
			store,
			MiscKey::Random,
			state::random_record(self.rand, self.random_plain),
		);
	}

	/// The host clock reading of `vp`'s start or last `SECONDS=` in bash
	/// code (bash's `shellstart`: `printf '%(…)T' -2`, `time`): a forked
	/// vproc's own ([`proc::Clock`]), else the shell's.
	pub fn start_of(&self, vp: &Vproc) -> u64 {
		vp.clock.as_ref().map_or(self.start_ns, |c| c.start_ns)
	}

	/// The host clock reading `vp`'s `$SECONDS` counts from: its start, moved
	/// back by the value of its last `SECONDS=` in bash code (zsh code's
	/// `$SECONDS`).
	pub fn seconds_origin(&self, vp: &Vproc) -> u64 {
		let (start, seconds) = vp
			.clock
			.as_ref()
			.map_or((self.start_ns, self.seconds), |c| (c.start_ns, c.seconds));
		start.wrapping_sub((seconds as u64).wrapping_mul(1_000_000_000))
	}

	/// `$SECONDS` in bash code at host clock reading `now`: the value of
	/// `vp`'s last `SECONDS=` plus the whole seconds since its start (bash's
	/// `get_seconds`, `seconds_value_assigned + time_since_start`).
	pub fn seconds_now(&self, vp: &Vproc, now: u64) -> i64 {
		let (start, seconds) = vp
			.clock
			.as_ref()
			.map_or((self.start_ns, self.seconds), |c| (c.start_ns, c.seconds));
		let since = (now.wrapping_sub(start) as i64).div_euclid(1_000_000_000);
		seconds.wrapping_add(since)
	}

	/// Whether `unset`, or an array assignment, removed the special meaning
	/// of `vp`'s `RANDOM` or `SECONDS` in bash code.
	pub const fn plain(&self, vp: &Vproc, s: dynvars::Special) -> bool {
		match (s, vp.clock.as_ref()) {
			(dynvars::Special::Random, Some(c)) => c.random_plain,
			(dynvars::Special::Random, None) => self.random_plain,
			(dynvars::Special::Seconds, Some(c)) => c.seconds_plain,
			(dynvars::Special::Seconds, None) => self.seconds_plain,
		}
	}

	/// `SECONDS=…` in `vp`: its start is `start` and `$SECONDS` adds
	/// `seconds` (bash code: now and the value, as bash's `assign_seconds`;
	/// zsh code: the moved origin and 0). The shell's are written through.
	pub fn set_seconds(
		&mut self,
		store: &mut dyn StateStore,
		vp: &mut Vproc,
		start: u64,
		seconds: i64,
	) {
		if let Some(clock) = vp.clock.as_mut() {
			clock.start_ns = start;
			clock.seconds = seconds;
			return;
		}
		self.start_ns = start;
		self.seconds = seconds;
		self.write_start(store);
	}

	/// `unset` or an array assignment in bash code: `vp`'s `RANDOM` or
	/// `SECONDS` is a plain variable from now on. The shell's is written
	/// through.
	pub fn set_plain(&mut self, store: &mut dyn StateStore, vp: &mut Vproc, s: dynvars::Special) {
		match (s, vp.clock.as_mut()) {
			(dynvars::Special::Random, Some(c)) => c.random_plain = true,
			(dynvars::Special::Seconds, Some(c)) => c.seconds_plain = true,
			(dynvars::Special::Random, None) => {
				self.random_plain = true;
				self.write_random(store);
			},
			(dynvars::Special::Seconds, None) => {
				self.seconds_plain = true;
				self.write_start(store);
			},
		}
	}

	/// Whether `unset` removed the value cell `dynvars::CELLS[i]` of `vp` in
	/// bash code.
	pub fn cell_plain(&self, vp: &Vproc, i: usize) -> bool {
		(vp.clock.map_or(self.cells_plain, |c| c.cells_plain) & (1 << i)) != 0
	}

	/// `unset` of the value cell `dynvars::CELLS[i]` in bash code: a plain
	/// variable of `vp` from now on. The shell's is written through.
	pub fn set_cell_plain(&mut self, store: &mut dyn StateStore, vp: &mut Vproc, i: usize) {
		if let Some(c) = vp.clock.as_mut() {
			c.cells_plain |= 1 << i;
			return;
		}
		self.cells_plain |= 1 << i;
		self
			.root
			.set_misc(store, MiscKey::CellsPlain, self.cells_plain.to_string());
	}

	/// The shell's clock record ([`StartRecord`]).
	fn write_start(&mut self, store: &mut dyn StateStore) {
		let record =
			StartRecord { start: self.start_ns, seconds: self.seconds, plain: self.seconds_plain };
		self
			.root
			.set_misc(store, MiscKey::StartNs, record.to_string());
	}

	/// A fresh vpid; the counter is written through (a shell restored from
	/// the store alone never reuses one). The caller checked
	/// [`Self::vpids_left`]: none is given past [`Vpid::CEILING`], and the
	/// counter never wraps into numbers an OS pid can take.
	pub fn vpid(&mut self, store: &mut dyn StateStore) -> Vpid {
		debug_assert!(self.next_vpid <= Vpid::CEILING, "no vpid left: the caller checks vpids_left");
		let v = Vpid(self.next_vpid);
		self.next_vpid = self.next_vpid.saturating_add(1);
		self.written_vpid = self.next_vpid;
		self
			.root
			.set_misc(store, MiscKey::NextVpid, self.next_vpid.to_string());
		v
	}

	/// Vpids still to give ([`Vpid::CEILING`] is the last): a command that
	/// needs more fails before it builds anything, as bash's does when it
	/// cannot fork ([`exec::fork_failed`]).
	pub const fn vpids_left(&self) -> u32 {
		(Vpid::CEILING + 1).saturating_sub(self.next_vpid)
	}

	/// Write `unit`'s blob ([`BlobSlot::Unit`](crate::bash::store::BlobSlot))
	/// once per id: a function body is in the store from its definition on,
	/// so a shell restored from the store alone keeps its line numbers.
	pub fn persist_unit(&mut self, store: &mut dyn StateStore, unit: &Unit) {
		if !self.note_written(unit.id) {
			return;
		}
		let mut buf = core::mem::take(&mut self.blob_buf);
		buf.clear();
		let written = postcard::to_extend(unit, buf)
			.map_err(StoreError::Encode)
			.and_then(|buf| {
				let put = store.put_blob(crate::bash::store::BlobSlot::Unit(unit.id), &buf);
				if buf.capacity() <= SPARE_BUFFER_BYTES {
					self.blob_buf = buf;
				}
				put
			});
		if let Err(err) = written {
			self.written.remove(&unit.id);
			self.fail(err);
		}
	}

	/// Note that `id`'s blob is in the store; `false` when it already was
	/// known. Past [`WRITTEN_MAX`] ids the set starts over: forgetting one
	/// only costs writing its blob again, while a long-lived shell compiles
	/// new units without end.
	pub(crate) fn note_written(&mut self, id: UnitId) -> bool {
		if self.written.len() >= WRITTEN_MAX && !self.written.contains(&id) {
			self.written.clear();
		}
		self.written.insert(id)
	}

	/// Lend `tree`'s buffers to the next parse ([`Kernel::spare_tree`]),
	/// unless they outgrew [`SPARE_BUFFER_BYTES`]: one huge command's tree
	/// is freed rather than held for the shell's lifetime.
	pub(crate) fn keep_spare_tree(&mut self, tree: crate::bash::syntax::Tree) {
		if tree.heap_bytes() <= SPARE_BUFFER_BYTES {
			self.spare_tree = tree;
		}
	}

	/// Write the root vproc's in-place fields ([`state::sync_root`]) and a
	/// vpid counter advanced without the store (`Shell::submit`): called
	/// before every engine call returns.
	pub fn sync_root(&mut self, store: &mut dyn StateStore, root: &mut Vproc) {
		state::sync_root(&mut self.root, store, root);
		if self.next_vpid != self.written_vpid {
			self.written_vpid = self.next_vpid;
			self
				.root
				.set_misc(store, MiscKey::NextVpid, self.next_vpid.to_string());
		}
	}

	/// A fresh job id; the counter is written through.
	pub fn job_id(&mut self, store: &mut dyn StateStore) -> JobId {
		let id = JobId(self.next_job);
		self.next_job += 1;
		self
			.root
			.set_misc(store, MiscKey::NextJob, self.next_job.to_string());
		id
	}

	/// The vproc that runs (or ran) the program OS pid `pid` names when
	/// that is not its job's own vproc ([`Self::pid_owners`]).
	pub fn pid_owner(&self, pid: u32) -> Option<Vpid> {
		self
			.pid_owners
			.iter()
			.find(|&&(p, ..)| p == pid)
			.map(|&(_, owner, _)| owner)
	}

	/// Child vproc `vpid` of `parent` ended with `status`; the record stays
	/// until the status is collected ([`Self::proc_collect`]). A record
	/// `disown` left with no parent ([`Self::disown`]) keeps naming none:
	/// `wait` does not find it, and `kill` of `$!` still sees the child gone.
	pub fn proc_exited(
		&mut self,
		store: &mut dyn StateStore,
		vpid: Vpid,
		parent: Option<Vpid>,
		status: i32,
	) {
		self.pid_owners.retain(|&(.., job)| job != vpid);
		self.stage_vpids.retain(|(job, _)| *job != vpid);
		let parent = match store.get(Key::Proc(vpid)) {
			Ok(Some(Record::Proc { parent: None, .. })) => None,
			_ => parent,
		};
		let rec = Record::Proc { parent, status: Some(status) };
		self.root.write(store, Change::Put(Key::Proc(vpid), rec));
	}

	/// Child vproc `vpid`'s state: `None` unknown (never started here, or
	/// collected). A store failure reads as unknown (and is kept for the
	/// next turn).
	pub fn proc_state(&mut self, store: &mut dyn StateStore, vpid: Vpid) -> Option<ProcState> {
		match store.get(Key::Proc(vpid)) {
			Ok(Some(Record::Proc { status, .. })) => {
				Some(status.map_or(ProcState::Running, ProcState::Exited))
			},
			Ok(_) => None,
			Err(err) => {
				self.root.fail(err);
				None
			},
		}
	}

	/// Whether `vp` started child vproc `vpid` (its record names `vp` as
	/// parent): a subshell copies `$!`, not its parent's children.
	pub fn started(&mut self, store: &mut dyn StateStore, vp: Vpid, vpid: Vpid) -> bool {
		match store.get(Key::Proc(vpid)) {
			Ok(Some(Record::Proc { parent, .. })) => *parent == Some(vp),
			Ok(_) => false,
			Err(err) => {
				self.root.fail(err);
				false
			},
		}
	}

	/// Take the exit status of finished child vproc `vpid` (its record goes);
	/// `None` while it runs or when unknown.
	pub fn proc_collect(&mut self, store: &mut dyn StateStore, vpid: Vpid) -> Option<i32> {
		let status = self.proc_state(store, vpid)?.exited()?;
		self.root.write(store, Change::Del(Key::Proc(vpid)));
		Some(status)
	}

	/// The clock for an event now: the last reading while it is still
	/// current ([`Self::clock`]), else a fresh [`crate::bash::Host::now_ns`]
	/// that later events may share. For events at the start of something
	/// (`CmdStart`, `CmdExpanded`, `FuncEnter`).
	#[inline]
	pub fn stamp(&mut self, cx: &Cx<'_>) -> u64 {
		match self.clock {
			Some(t) => t,
			None => self.read_clock(cx),
		}
	}

	/// A fresh [`crate::bash::Host::now_ns`] (a duration ends here: `CmdEnd`),
	/// kept for the events that follow ([`Self::stamp`]).
	#[inline]
	pub fn read_clock(&mut self, cx: &Cx<'_>) -> u64 {
		let t = cx.host.now_ns();
		self.clock = Some(t);
		t
	}

	/// Something that can take time starts (or a vproc's turn does): the
	/// next [`Self::stamp`] reads the clock.
	#[inline]
	pub const fn clock_stale(&mut self) {
		self.clock = None;
	}

	/// Emit an event without a node if its kind is enabled; applies the
	/// host's verdict.
	#[inline]
	pub fn emit(
		&mut self,
		cx: &mut Cx<'_>,
		(vpid, mode): (Vpid, ModeId),
		run: Option<&Run>,
		data: EventData<'_>,
	) {
		if self.mask.contains(data.kind()) {
			let t_ns = cx.host.now_ns();
			self.deliver_at(cx, (vpid, mode), run, data, t_ns);
		}
	}

	/// The event of [`Self::emit`] handed to the host, out of line: its
	/// callers inline only the mask test (a disabled kind costs one AND and
	/// touches nothing else).
	#[inline(never)]
	fn deliver_at(
		&mut self,
		cx: &mut Cx<'_>,
		(vpid, mode): (Vpid, ModeId),
		run: Option<&Run>,
		data: EventData<'_>,
		t_ns: u64,
	) {
		let ev = Event::of_run(self.seq, t_ns, vpid, run, mode, data);
		self.send(cx, &ev);
	}

	/// Hand `ev` (numbered with the current `seq`) to the host and apply its
	/// verdict. Inline: at the hot `emit_op_at` sites the event costs the
	/// host's call and nothing around it; a verdict other than `Continue`
	/// takes the out-of-line [`Self::apply_verdict`].
	#[inline]
	fn send(&mut self, cx: &mut Cx<'_>, ev: &Event<'_>) {
		self.seq += 1;
		let verdict = cx.host.event(ev);
		if verdict != Verdict::Continue {
			self.apply_verdict(verdict);
		}
	}

	/// A host's `Pause` or `Cancel` verdict, as a control request.
	#[cold]
	#[inline(never)]
	fn apply_verdict(&self, verdict: Verdict) {
		match verdict {
			Verdict::Continue => {},
			Verdict::Pause => self.ctl.request(PAUSE, RESUME),
			Verdict::Cancel(sig) => self.ctl.request_cancel(sig),
		}
	}

	/// Emit an event at `node` of the vproc's current frame. A disabled kind
	/// returns before anything else; an enabled one stores the vproc and the
	/// node, which the host resolves only if it reads them
	/// ([`Event::node`], [`Event::span`], [`Event::run`]).
	#[inline]
	pub fn emit_op(&mut self, cx: &mut Cx<'_>, vp: &Vproc, node: u32, data: EventData<'_>) {
		if self.mask.contains(data.kind()) {
			if self
				.mask
				.contains(crate::bash::event::EventKind::UnitCompiled)
				&& matches!(
					&data,
					EventData::Subshell { .. }
						| EventData::Background { .. }
						| EventData::Pipeline { .. }
				)
				&& let Some(origins) = self.trace_unit_origins.get(&vp.vpid).cloned()
			{
				match &data {
					EventData::Subshell { child } | EventData::Background { pid: child, .. } => {
						self.trace_unit_origins.entry(*child).or_insert(origins);
					},
					EventData::Pipeline { stages } => {
						for child in *stages {
							self
								.trace_unit_origins
								.entry(*child)
								.or_insert_with(|| Arc::clone(&origins));
						}
					},
					_ => {},
				}
			}
			let t_ns = cx.host.now_ns();
			self.deliver_op(cx, vp, node, data, t_ns);
		}
	}

	/// [`Self::emit_op`] stamped `t_ns`, a reading the caller took for the
	/// event's own duration or shares ([`Self::stamp`],
	/// [`Self::read_clock`]); take it only when the kind is enabled.
	#[inline]
	pub fn emit_op_at(
		&mut self,
		cx: &mut Cx<'_>,
		vp: &Vproc,
		node: u32,
		data: EventData<'_>,
		t_ns: u64,
	) {
		if self.mask.contains(data.kind()) {
			// Built in place at the (few, hot) callers: no lookup, one call
			// per event.
			let ev = Event::of_op(self.seq, t_ns, vp, node, data);
			self.send(cx, &ev);
		}
	}

	/// The event of [`Self::emit_op`] handed to the host, out of line like
	/// [`Self::deliver_at`].
	#[inline(never)]
	fn deliver_op(
		&mut self,
		cx: &mut Cx<'_>,
		vp: &Vproc,
		node: u32,
		data: EventData<'_>,
		t_ns: u64,
	) {
		let ev = Event::of_op(self.seq, t_ns, vp, node, data);
		self.send(cx, &ev);
	}

	/// Queue a diagnostic on the vproc's stderr and emit a `Diag` event.
	pub fn diag(&mut self, cx: &mut Cx<'_>, vp: &mut Vproc, line: u32, diag: Diag) {
		zle::display::trash_for_message(self, cx, vp);
		let bytes = self.render_diag(cx, vp, line, &diag);
		vp.out.push_back(PendingWrite::new(2, bytes.into()));
	}

	/// The stderr bytes of a diagnostic; emits the `Diag` event. Builtins
	/// queue the bytes with their own output to keep stdout/stderr order.
	pub fn render_diag(&mut self, cx: &mut Cx<'_>, vp: &Vproc, line: u32, diag: &Diag) -> Vec<u8> {
		let bytes = self.render_quiet(cx, vp, line, diag);
		self.diag_event(cx, vp, diag, b"");
		bytes
	}

	/// The stderr bytes of a diagnostic, without its event: also what a
	/// spawned process prints for a redirection it applies itself
	/// ([`crate::bash::ChildRedir`]).
	pub fn render_quiet(&mut self, cx: &mut Cx<'_>, vp: &Vproc, line: u32, diag: &Diag) -> Vec<u8> {
		if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			let (mut prefix, mut zline) = self.zsh_site(cx, vp, line);
			if let Some(caller) = widget_caller_line(vp) {
				zline = caller;
			} else if self.zsh_shinstdin(cx, vp) {
				prefix.clear();
				zline = 0;
			}
			let utf8 = zsh::params::mb_in(self, cx.store, vp).unwrap_or(false);
			return crate::bash::diag::render_zsh(diag, crate::bash::diag::ZshSite {
				prefix: &prefix,
				line: zline,
				utf8,
			});
		}
		static COMMAND: Origin = Origin::Command;
		let origin = vp
			.runs
			.front()
			.and_then(|r| r.chain.links.first())
			.map_or(&COMMAND, |l| &l.origin);
		let utf8 = locale::is_utf8(self, cx.store, vp);
		// An in-engine nested shell names itself (its `$0`).
		let shell_name = match vp
			.image
			.as_ref()
			.and_then(|image| image.get(Key::Misc(MiscKey::Argv0)))
		{
			Some(Record::Misc(name)) => name.as_slice(),
			_ => self.argv0.as_slice(),
		};
		render(diag, DiagSite { shell_name, origin, line, utf8 })
	}

	/// The `Diag` event of a diagnostic `vp` prints, `tail` after its text
	/// (bytes, which a diagnostic's text is not: the command of bash's
	/// killed-command notice).
	fn diag_event(&mut self, cx: &mut Cx<'_>, vp: &Vproc, diag: &Diag, tail: &[u8]) {
		if self.mask.contains(crate::bash::event::EventKind::Diag) {
			let mut message = BString::from(diag.to_string());
			message.extend_from_slice(tail);
			self.emit(cx, (vp.vpid, vp.mode), vp.runs.front(), EventData::Diag {
				code:    diag.code(),
				message: BStr::new(&message),
			});
		}
	}

	/// zsh's `scriptname` and `lineno` for a diagnostic of `vp` at script
	/// line `line` (zsh `zwarning`): the innermost function's name with the
	/// line counted from its definition, `(eval)` with the line in the
	/// eval'd text, a sourced file's name, the script's path, or `zsh` for a
	/// `-c` string or standard input.
	fn zsh_site(&self, cx: &mut Cx<'_>, vp: &Vproc, line: u32) -> (BString, u32) {
		let (name, base) = self.zsh_site_base(cx.store, vp);
		(name, line.saturating_sub(base))
	}

	/// zsh `zwarning`'s `isset(SHINSTDIN) && !locallevel`: commands read
	/// from standard input, outside functions (`locallevel`) and sourced
	/// files (`source` turns `shinstdin` off), report without a script name
	/// or line ([`crate::bash::diag::ZshSite`] with an empty prefix). A
	/// widget runs in a parameter scope of its own (`execzlefunc` and
	/// `callcompfunc` call `startparamscope`, which raises `locallevel`). A
	/// subshell decides by the site it inherited.
	fn zsh_shinstdin(&mut self, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
		if zle::editor(vp).is_some_and(|ed| ed.in_widget > 0) {
			return false;
		}
		let mut top = false;
		for f in &vp.frames {
			match f.kind {
				FrameKind::Function { .. } | FrameKind::Script { what: ScriptKind::Source, .. } => {
					return false;
				},
				FrameKind::Script { what: ScriptKind::Run, .. } => top = true,
				_ => {},
			}
		}
		let inherited = vp.zsh.as_ref().and_then(|z| z.site.as_ref());
		if !top && inherited.is_none_or(|(name, _)| name.as_slice() != b"zsh") {
			return false;
		}
		let opt = crate::bash::zshopt::ZshOpt::Shinstdin;
		state::zsh_option(&mut self.root, cx.store, vp, opt).unwrap_or(false)
	}

	/// [`Self::zsh_site`] of `vp` as the script name and the script line
	/// its lines count from (`u32::MAX`: a function without a definition
	/// line, which prints no line); a subshell without a site of its own
	/// takes the one its parent had when it started ([`proc::VprocZsh::site`]).
	pub(super) fn zsh_site_base(&self, store: &mut dyn StateStore, vp: &Vproc) -> (BString, u32) {
		// Code a builtin runs (`ScriptKind::Code`) keeps the line numbers
		// it was parsed with: its caller's name, no function offset.
		let mut code = false;
		// A function whose body is a lone command without braces names the
		// site; its lines are the caller's, counted from the caller's base.
		let mut named: Option<BString> = None;
		let site = |named: Option<BString>, name: BString, base: u32| (named.unwrap_or(name), base);
		for (i, f) in vp.frames.iter().enumerate().rev() {
			match &f.kind {
				FrameKind::Script { what: ScriptKind::Code(_), .. } => code = true,
				FrameKind::Function { name, .. } if i > 0 && !code && exec::keeps_caller_line(f) => {
					named.get_or_insert_with(|| name.clone());
				},
				// zsh numbers a function's lines from its definition's (0,
				// which prints no line).
				FrameKind::Function { name, .. } => {
					let start = if code {
						0
					} else {
						f.unit
							.as_ref()
							.map_or(u32::MAX, |u| callstack::definition_line(u))
					};
					return site(named, name.clone(), start);
				},
				// The text of a command substitution run in a child vproc:
				// zsh reports it under its parent's name.
				FrameKind::Script { what: ScriptKind::Eval, .. } if i == 0 && vp.parent.is_some() => {},
				FrameKind::Script { what: ScriptKind::Eval, .. } => {
					return site(named, BString::from("(eval)"), 0);
				},
				FrameKind::Script { what: ScriptKind::Source, .. } => {
					let file = vp.calls.iter().rev().find_map(|c| match &c.kind {
						callstack::CallKind::Source { file, .. } => Some(file.clone()),
						_ => None,
					});
					return site(named, file.unwrap_or_else(|| BString::from("zsh")), 0);
				},
				FrameKind::Script { what: ScriptKind::Run, .. } => {
					let link = vp.runs.front().and_then(|r| r.chain.links.first());
					let name = if let Some(l) = link {
						if let Origin::File(path) = &l.origin {
							path.clone()
						} else {
							BString::from("zsh")
						}
					} else {
						let argv0 =
							state::dollar0(store, vp, &self.argv0).unwrap_or_else(|_| self.argv0.clone());
						let base = argv0.rsplit(|&c| c == b'/').next().unwrap_or_default();
						BString::from(base)
					};
					return site(named, name, 0);
				},
				_ => {},
			}
		}
		match vp.zsh.as_ref().and_then(|z| z.site.as_ref()) {
			Some((name, base)) => site(named, name.clone(), *base),
			None => site(named, BString::from("zsh"), 0),
		}
	}

	/// Record a store failure; the next scheduler turn abandons every script.
	pub fn fail(&mut self, err: StoreError) {
		self.root.fail(err);
	}
}

/// zsh's `lineno` for a diagnostic of the code the line editor runs for a
/// widget ([`ScriptKind::Hook`] frames on top of the stack, inside a
/// widget): zsh calls the widget's function directly, so before the
/// function runs (its autoload stub failing, zsh `loadautofn`) the line is
/// that of the code the editor runs for: the line being read at the
/// prompt (the reader's next line), or the line of the command that
/// started the editor (`vared`). `None` outside that case.
fn widget_caller_line(vp: &Vproc) -> Option<u32> {
	let hook = |f: &Frame| matches!(f.kind, FrameKind::Script { what: ScriptKind::Hook, .. });
	if zle::editor(vp).is_none_or(|ed| ed.in_widget == 0) || !vp.frames.last().is_some_and(hook) {
		return None;
	}
	let fi = vp.frames.iter().rposition(|f| !hook(f))?;
	let caller = &vp.frames[fi];
	match (&caller.unit, &caller.kind) {
		(Some(u), _) => u
			.ops
			.get(caller.pc as usize)
			.map(|op| exec::line_in(vp, fi, op.node)),
		(None, FrameKind::Script { pos, .. }) => Some(pos.1),
		(None, _) => None,
	}
}

/// The level an imported `SHLVL` gives (before the shell adds one): bash
/// takes a whole number or 0, zsh (`zstrtol`, never evaluated) the leading
/// number. Called at shell startup and for nested shells.
fn imported_shlvl(value: &[u8], zsh: bool) -> i32 {
	if !zsh {
		return std::str::from_utf8(value)
			.ok()
			.and_then(|v| v.parse().ok())
			.unwrap_or(0);
	}
	let v = value.trim_ascii_start();
	let (neg, digits) = match v.split_first() {
		Some((b'-', rest)) => (true, rest),
		Some((b'+', rest)) => (false, rest),
		_ => (false, v),
	};
	let n = digits
		.iter()
		.take_while(|c| c.is_ascii_digit())
		.fold(0i32, |n, &c| n.wrapping_mul(10).wrapping_add(i32::from(c - b'0')));
	if neg { n.wrapping_neg() } else { n }
}

/// Whether `name` is a shell identifier.
pub fn is_ident(name: &[u8]) -> bool {
	name
		.first()
		.is_some_and(|&c| c == b'_' || c.is_ascii_alphabetic())
		&& name.iter().all(|&c| c == b'_' || c.is_ascii_alphanumeric())
}

/// The shell's own stdio as an fd table.
fn host_stdio(host: &mut dyn Host, cache: &mut [Option<FdRef>; 3]) -> FdTable {
	let mut fds = FdTable::default();
	for s in [StdFd::Stdin, StdFd::Stdout, StdFd::Stderr] {
		let i = s.fd() as usize;
		let r = cache[i].get_or_insert_with(|| match host.stdio(s) {
			Some(f) => FdRef::open(f, FdOrigin::Std(s)),
			None => FdRef::closed(),
		});
		fds.set(s.fd(), Some(r.clone()));
	}
	fds
}

/// Shell variables bash sets at startup (not exported unless imported).
fn startup_vars(k: &mut Kernel, cx: &mut Cx<'_>, init: &ShellInit) -> Result<(), StoreError> {
	let ppid = cx.host.ppid();
	let need_shell = state::global(cx.store, b"SHELL")?.is_none();
	let deferred_shell = need_shell
		&& init.mode.dialect() != crate::bash::ids::Dialect::Zsh
		&& match cx.host.login_shell_initializer() {
			Some(initializer) => cx.store.defer_scalar(b"SHELL", Attrs::NONE, initializer)?,
			None => false,
		};
	let values = if init.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		zsh_startup_values(cx, k.engine.config().platform)
	} else {
		startup_values(cx, &init.argv0, ppid, k.engine.config().platform, StartupVars {
			lookup_shell: need_shell && !deferred_shell,
			interactive:  init.interactive,
			login_home:   init.login_home,
		})
	};
	// zsh started as sh or ksh has no `MANPATH` and no prompt aliases
	// (`special_params_sh`).
	let started_sh =
		matches!(init.mode, crate::bash::ids::ModeId::ZshSh | crate::bash::ids::ModeId::Ksh);
	if started_sh {
		k.root.set_misc(cx.store, MiscKey::ZshStartedSh, "1");
	}
	for (name, var, forced) in values {
		if started_sh && name == b"MANPATH" {
			continue;
		}
		if forced || state::global(cx.store, name)?.is_none() {
			k.root.set_var(cx.store, name, Some(var));
		}
	}
	// zsh's other prompt names share the variable of `PS1`, … (`RPS1`
	// and `RPS2` start unset, and so do their other names).
	if init.mode.dialect() == crate::bash::ids::Dialect::Zsh && !started_sh {
		for group in crate::bash::vm::zsh::specials::PROMPT_GROUPS {
			let value = match state::global(cx.store, group[0])? {
				Some(Var { value: VarValue::Str(s), .. }) => s.clone(),
				Some(_) => BString::default(),
				None => continue,
			};
			for &name in &group[1..] {
				if state::global(cx.store, name)?.is_none() {
					k.root
						.set_var(cx.store, name, Some(Var::scalar(value.clone(), Attrs::NONE)));
				}
			}
		}
	}
	if init.mode.dialect() == crate::bash::ids::Dialect::Zsh
		&& let Some(dirs) = &init.zsh_fpath
		&& !init.env.iter().any(|(n, _)| n == "FPATH")
	{
		let sep = crate::bash::vm::probe::path_separator(k.engine.config().platform);
		let joined = bstr::join([sep], dirs);
		k.root
			.set_var(cx.store, b"FPATH", Some(Var::scalar(BString::from(joined), Attrs::NONE)));
	}
	for (name, value) in &init.zsh_params {
		k.root
			.set_var(cx.store, name, Some(Var::scalar(value.clone(), Attrs::NONE)));
	}
	Ok(())
}

/// The plain variables zsh 5.9 sets at startup (`init.c` `setupvals`,
/// `params.c` defaults), as `(name, value, forced)` like
/// [`startup_values`]; zsh's special parameters (`PPID`, `USERNAME`,
/// `ZSH_VERSION`, …) are computed by the zsh dialect, not stored.
pub fn zsh_startup_values(
	cx: &mut Cx<'_>,
	platform: crate::bash::ids::Platform,
) -> Vec<(&'static [u8], Var, bool)> {
	let user = cx.host.user();
	let defaults: [(&'static [u8], &[u8]); 20] = [
		(b"IFS", b" \t\n\0"),
		(b"PS1", b"%m%# "),
		(b"PS2", b"%_> "),
		(b"PS3", b"?# "),
		(b"PS4", b"+%N:%i> "),
		(b"SPROMPT", b"zsh: correct '%R' to '%r' [nyae]? "),
		(b"WORDCHARS", b"*?_-.[]~=/&;!#$%^(){}<>"),
		(b"TMPPREFIX", b"/tmp/zsh"),
		(b"TIMEFMT", b"%J  %U user %S system %P cpu %*E total"),
		(b"OPTIND", b"1"),
		(b"PATH", b"/bin:/usr/bin:/usr/ucb:/usr/local/bin"),
		(b"NULLCMD", b"cat"),
		(b"READNULLCMD", b"more"),
		// The scalar sides of the special ties start set (empty): `$+cdpath`
		// is 1 until `unset CDPATH` (`params.c` `IPDEF8`). `fpath` and
		// `module_path` start with the system zsh's compiled-in directories
		// (`init.c` `setupvals`: `FPATH_DIR`, `MODULE_DIR`).
		(b"FPATH", b"/usr/local/share/zsh/site-functions:/usr/share/zsh/site-functions:/usr/share/zsh/5.9/functions"),
		(b"CDPATH", b""),
		(b"MANPATH", b""),
		(b"MODULE_PATH", b"/usr/lib/zsh/5.9"),
		(b"MAILPATH", b""),
		(b"PSVAR", b""),
		(b"FIGNORE", b""),
	];
	// `MODULE_PATH` is never imported (`PM_DONTIMPORT`). The directory
	// lists take the platform's separator, as their ties split them.
	let sep = crate::bash::vm::probe::path_separator(platform);
	let mut out: Vec<(&'static [u8], Var, bool)> = defaults
		.into_iter()
		.map(|(name, value)| {
			let value: BString = if matches!(name, b"PATH" | b"FPATH") {
				value
					.iter()
					.map(|&c| if c == b':' { sep } else { c })
					.collect::<Vec<u8>>()
					.into()
			} else {
				value.into()
			};
			(name, Var::scalar(value, Attrs::NONE), name == b"MODULE_PATH")
		})
		.collect();
	// `setiparam`: integers.
	let integers: [(&'static [u8], &[u8]); 3] =
		[(b"MAILCHECK", b"60"), (b"KEYTIMEOUT", b"40"), (b"LISTMAX", b"100")];
	for (name, value) in integers {
		out.push((name, Var::scalar(value, Attrs::INTEGER), false));
	}
	// zsh exports `HOME` and `LOGNAME` (`addenv` when not imported); `HOME`
	// is `/` for a user without a password database entry (`setupvals`), and
	// `LOGNAME` the session's login name when it has one (`params.c`, which
	// tries `getlogin` first), else the password database's name.
	let home = if user.home.is_empty() {
		BString::from("/")
	} else if platform == crate::bash::ids::Platform::Windows {
		builtins::zsh_dir::windows_spelling(&user.home, &user.home)
	} else {
		user.home.clone()
	};
	out.push((&b"HOME"[..], Var::scalar(home, Attrs::EXPORT), false));
	let logname = cx
		.host
		.login_name()
		.filter(|name| !name.is_empty())
		.unwrap_or(user.name);
	out.push((&b"LOGNAME"[..], Var::scalar(logname, Attrs::EXPORT), false));
	let (_, release, machine) = cx.host.uname().unwrap_or_default();
	let macos = cfg!(target_os = "macos");
	// The configure-time `MACHTYPE`, `VENDOR` and `OSTYPE` of the system's
	// zsh (Apple's build reports `x86_64` on every Mac).
	let machtype = if macos {
		BString::from("x86_64")
	} else {
		BString::from(std::env::consts::ARCH)
	};
	let vendor = if macos {
		"apple"
	} else if std::env::consts::ARCH == "x86_64" {
		"pc"
	} else {
		"unknown"
	};
	let ostype = if platform == crate::bash::ids::Platform::Windows {
		// MSYS2's zsh, the zsh Windows users and plugins know.
		BString::from("msys")
	} else if macos {
		let mut o = BString::from("darwin");
		if let Some(major) = release
			.split(|&c| c == b'.')
			.next()
			.filter(|m| !m.is_empty())
		{
			o.extend_from_slice(major);
			o.extend_from_slice(b".0");
		}
		o
	} else {
		BString::from("linux-gnu")
	};
	let tty = cx
		.host
		.terminal()
		.and_then(|t| t.open_controlling().ok().flatten())
		.map_or_default(|s| s.name);
	// `HOST` is set before the environment is imported, the others after.
	let cputype = if !machine.is_empty() {
		machine
	} else if macos && std::env::consts::ARCH == "aarch64" {
		BString::from("arm64")
	} else {
		BString::from(std::env::consts::ARCH)
	};
	let fixed: [(&'static [u8], BString, bool); 6] = [
		(b"HOST", cx.host.hostname(), false),
		(b"CPUTYPE", cputype, true),
		(b"MACHTYPE", machtype, true),
		(b"OSTYPE", ostype, true),
		(b"TTY", tty, true),
		(b"VENDOR", BString::from(vendor), true),
	];
	for (name, value, forced) in fixed {
		out.push((name, Var::scalar(value, Attrs::NONE), forced));
	}
	// `signals`: `EXIT`, zsh's signal names by number, `ZERR`, `DEBUG`.
	let mut signals = vec![BString::from("EXIT")];
	for n in 1..=31u8 {
		match crate::bash::signal::Signal::from_number(n, platform) {
			Some(s) => signals.push(BString::from(s.zsh_name(platform))),
			None => signals.push(BString::from(format!("SIG{n}"))),
		}
	}
	signals.push(BString::from("ZERR"));
	signals.push(BString::from("DEBUG"));
	out.push((
		&b"signals"[..],
		Var {
			attrs: Attrs::NONE,
			value: VarValue::Indexed(
				signals
					.into_iter()
					.enumerate()
					.map(|(i, s)| (i64::try_from(i).unwrap_or(0), s))
					.collect(),
			),
		},
		true,
	));
	out
}

/// Startup-only defaults shared by root and nested bash/sh shells.
pub struct StartupVars {
	lookup_shell: bool,
	interactive:  bool,
	/// bash sets `HOME` when the environment has none
	/// ([`crate::bash::invocation::ShellArgs::login_home`]).
	login_home:   bool,
}

/// bash's startup variables of a new shell named `argv0` whose `$PPID` is
/// `ppid`, as `(name, value, forced)`: a variable already set (imported)
/// keeps its value unless `forced`. Shared by [`Shell::create`] and the
/// in-engine nested shell (`nested`). The login shell is looked up only
/// when needed; the primary prompt is initialized only for interactive shells.
pub fn startup_values(
	cx: &Cx<'_>,
	argv0: &[u8],
	ppid: u32,
	platform: crate::bash::ids::Platform,
	options: StartupVars,
) -> Vec<(&'static [u8], Var, bool)> {
	let user = cx.host.user();
	let shell = if options.lookup_shell {
		cx.host.login_shell().unwrap_or_default()
	} else {
		BString::default()
	};
	let home = if options.login_home {
		// bash `sh_get_home_dir`: the entry's home, `/` without one.
		Some(if user.home.is_empty() {
			BString::from("/")
		} else {
			user.home.clone()
		})
	} else {
		None
	};
	let defaults: [(&'static [u8], BString); 16] = [
		(b"IFS", BString::from(" \t\n")),
		(b"PS2", BString::from("> ")),
		(b"PS4", BString::from("+ ")),
		(b"OPTIND", BString::from("1")),
		(b"OPTERR", BString::from("1")),
		(b"BASH_VERSION", BString::from(BASH_VERSION)),
		(b"BASH", BString::from(argv0)),
		(b"HOSTNAME", cx.host.hostname()),
		(b"PPID", BString::from(ppid.to_string())),
		(b"UID", BString::from(user.uid.to_string())),
		(b"EUID", BString::from(user.euid.to_string())),
		(b"HOSTTYPE", BString::from(std::env::consts::ARCH)),
		(b"OSTYPE", BString::from(std::env::consts::OS)),
		(b"SHELL", shell),
		(b"TERM", BString::from("dumb")),
		// bash's `DEFAULT_PATH_VALUE` when the environment has no PATH.
		(b"PATH", BString::from(crate::bash::invocation::default_path(platform))),
	];
	let mut out = Vec::with_capacity(defaults.len() + 2 + usize::from(options.interactive));
	if options.interactive {
		out.push((&b"PS1"[..], Var::scalar(BString::from(r"\s-\v\$ "), Attrs::NONE), false));
	}
	if let Some(home) = home {
		out.push((&b"HOME"[..], Var::scalar(home, Attrs::NONE), false));
	}
	for (name, value) in defaults {
		// bash sets `SHELL` from the password database entry
		// (`set_shell_var`: the entry's shell, `/bin/sh` without one); `HOME`
		// only for a login shell, above: else `~` reads the entry.
		if name == b"SHELL" && value.is_empty() {
			continue;
		}
		// `PPID` and `EUID` (and `UID` when not imported) are readonly
		// integers; `PPID` is always the parent's.
		let attrs = if matches!(name, b"PPID" | b"UID" | b"EUID") {
			Attrs::READONLY.with(Attrs::INTEGER)
		} else {
			Attrs::NONE
		};
		out.push((name, Var::scalar(value, attrs), name == b"PPID"));
	}
	let versinfo = ["5", "3", "0", "1", "release", std::env::consts::ARCH];
	out.push((
		&b"BASH_VERSINFO"[..],
		Var {
			attrs: Attrs::READONLY,
			value: VarValue::Indexed(
				versinfo
					.iter()
					.enumerate()
					.map(|(i, v)| (i as i64, BString::from(*v)))
					.collect(),
			),
		},
		true,
	));
	// bash's `get_group_list`: the real gid first, then the supplementary
	// groups other than it. Assignments to `GROUPS` are ignored (`set_value`).
	let groups = std::iter::once(user.gid).chain(user.groups.into_iter().filter(|&g| g != user.gid));
	out.push((
		&b"GROUPS"[..],
		Var {
			attrs: Attrs::NONE,
			value: VarValue::Indexed(
				groups
					.enumerate()
					.map(|(i, g)| (i as i64, BString::from(g.to_string())))
					.collect(),
			),
		},
		true,
	));
	out
}

impl Shell {
	/// New shell: writes the initial root state (environment, `$0`,
	/// positional parameters, options, cwd, `$$`, bash's startup variables,
	/// imported functions) into `cx.store`.
	///
	/// # Errors
	///
	/// [`ShellError::UnknownOption`] for an option name bash does not know;
	/// [`ShellError::VpidBase`] for a vpid base an OS pid can take;
	/// [`ShellError::VpidBaseAtCeiling`] for one that leaves no vpid for a
	/// child;
	/// [`ShellError::Store`] when the store fails.
	pub fn create(
		engine: &Arc<Engine>,
		cx: &mut Cx<'_>,
		init: ShellInit,
	) -> Result<Self, ShellError> {
		let base = engine.config().vpid_base;
		if let Some(limit) = crate::bash::os_pid_limit()
			&& base < limit
		{
			return Err(ShellError::VpidBase { base, limit });
		}
		// The shell takes the base; a child needs a vpid above it.
		if base >= Vpid::CEILING {
			return Err(ShellError::VpidBaseAtCeiling { base });
		}
		let shell_pid = if init.shell_pid == 0 {
			cx.host.shell_pid()
		} else {
			init.shell_pid
		};
		let root = Root::load(cx.store).map_err(ShellError::Store)?;
		let mut k = Kernel::new(engine, root, init.argv0.clone(), shell_pid);
		k.rand = state::Random::new((cx.host.random() & 0xffff_ffff) as u32);
		k.write_random(cx.store);
		k.start_ns = cx.host.now_ns();
		k.root
			.set_misc(cx.store, MiscKey::StartNs, k.start_ns.to_string());
		k.startup.clone_from(&init.startup);
		let mut foreign: Vec<BString> = Vec::new();
		// zsh on Windows keeps directories spelled with `/` (`cd` does), so
		// `$PWD`, `$HOME` and `~` agree from the start.
		let zsh_on_windows = init.mode.dialect() == crate::bash::ids::Dialect::Zsh
			&& engine.config().platform == crate::bash::ids::Platform::Windows;
		let cwd = if zsh_on_windows {
			builtins::zsh_dir::windows_spelling(&init.cwd, &init.cwd)
		} else {
			init.cwd.clone()
		};
		for (name, value) in &init.env {
			if let Some(func) = name
				.strip_prefix(b"BASH_FUNC_")
				.and_then(|n| n.strip_suffix(b"%%"))
			{
				import_function(&mut k, cx.store, func, value);
			} else if is_ident(name) {
				let value = if zsh_on_windows && name == "HOME" {
					builtins::zsh_dir::windows_spelling(value, value)
				} else {
					value.clone()
				};
				k.root
					.set_var(cx.store, name, Some(Var::scalar(value, Attrs::EXPORT)));
			} else {
				let mut entry = name.clone();
				entry.push(b'=');
				entry.extend_from_slice(value);
				foreign.push(entry);
			}
		}
		if !foreign.is_empty() {
			k.root.set_record(
				cx.store,
				KeyBuf::Misc(MiscKey::ForeignEnv),
				Some(Record::Words(foreign)),
			);
		}
		k.root
			.set_var(cx.store, b"PWD", Some(Var::scalar(cwd.clone(), Attrs::EXPORT)));
		let zsh = init.mode.dialect() == crate::bash::ids::Dialect::Zsh;
		let shlvl = state::global(cx.store, b"SHLVL")?
			.and_then(|v| v.as_scalar())
			.map_or(0, |v| imported_shlvl(v, zsh));
		k.root
			.set_var(cx.store, b"SHLVL", Some(Var::scalar((shlvl + 1).to_string(), Attrs::EXPORT)));
		// bash's `init_seconds_var`: `SECONDS` from the environment, a
		// decimal number, is the count's starting value (else 0).
		if !zsh
			&& let Some(secs) = state::global(cx.store, b"SECONDS")?
				.and_then(|v| v.as_scalar())
				.and_then(builtins::valid_number)
		{
			k.seconds = secs;
			k.write_start(cx.store);
		}
		startup_vars(&mut k, cx, &init)?;
		// bash's `sv_strict_posix` at import: `POSIXLY_CORRECT` (or
		// `POSIX_PEDANTIC`) in the environment turns POSIX mode on; explicit
		// options below still win.
		let mut posix = init
			.env
			.iter()
			.any(|(n, _)| matches!(n.as_slice(), b"POSIXLY_CORRECT" | b"POSIX_PEDANTIC"));
		// A zsh-dialect shell's options are zsh's, applied once its root vproc
		// exists (below).
		let mut zsh_options = Vec::new();
		for (name, on) in &init.options {
			if zsh {
				let (opt, inverted) = crate::bash::zshopt::ZshOpt::lookup(name)
					.ok_or_else(|| ShellError::UnknownOption { name: name.clone() })?;
				zsh_options.push((opt, *on != inverted));
				continue;
			}
			let opt = OptId::from_name(name)
				.ok_or_else(|| ShellError::UnknownOption { name: name.clone() })?;
			k.root.set_option(cx.store, opt, *on);
			if opt == OptId::Posix {
				posix = *on;
			}
		}
		// Posix mode turns `expand_aliases` on (`bash --posix`, `-o posix`).
		if posix {
			k.root.set_option(cx.store, OptId::Posix, true);
			k.root.set_option(cx.store, OptId::ExpandAliases, true);
		}
		// bash `-i`: job control is on (`set -m`), also after a command-line
		// `+m`, which only declines to force it on (bash
		// `initialize_job_control (jobs_m_flag)`: an interactive shell takes
		// the terminal whatever the flag says); [`jobctl::init_io`] turns it
		// off again when there is no terminal to take over.
		if !zsh && init.interactive {
			k.root.set_option(cx.store, OptId::Monitor, true);
		}
		state::init_option_vars(&mut k.root, cx.store)?;
		k.root
			.set_misc(cx.store, MiscKey::Argv0, init.argv0.clone());
		k.root
			.set_misc(cx.store, MiscKey::ShellPid, shell_pid.to_string());
		k.root.set_misc(cx.store, MiscKey::Cwd, cwd.clone());
		k.root.set_misc(cx.store, MiscKey::Status, "0");
		k.root
			.set_misc(cx.store, MiscKey::Mode, <&'static str>::from(init.mode));
		k.root
			.set_misc(cx.store, MiscKey::Interactive, if init.interactive { "1" } else { "0" });
		if init.profile == Profile::Tool {
			k.root.set_misc(cx.store, MiscKey::Profile, "tool");
		}
		k.root
			.set_misc(cx.store, MiscKey::Umask, format!("{:04o}", cx.host.umask() & 0o7777));
		k.root.set_positional(cx.store, init.args);
		let vpid = k.vpid(cx.store);
		if let Some(err) = k.root.take_fault() {
			return Err(ShellError::Store(err));
		}
		let mut fds = host_stdio(cx.host, &mut [None, None, None]);
		for (fd, file) in cx.host.inherited_fds() {
			if fd > 2 {
				fds.set(fd, Some(FdRef::open(file, FdOrigin::Host)));
			}
		}
		let mut root = Vproc::new(vpid, None, fds, cwd, None, false);
		root.mode = init.mode;
		untrapped::init(&mut k, cx, &root, init.mode).map_err(ShellError::Store)?;
		if let Some(err) = k.root.take_fault() {
			return Err(ShellError::Store(err));
		}
		if zsh {
			let start = mode::ZshStart {
				mode:        init.mode,
				options:     &zsh_options,
				interactive: init.interactive,
				login:       init.argv0.first() == Some(&b'-'),
				stdin:       false,
			};
			mode::init_zsh_options(&mut k.root, cx.store, &mut root, &start)
				.map_err(ShellError::Store)?;
			// zsh `createaliastable`: every zsh starts with these two
			// aliases, `-f` and any emulation included.
			for (name, text) in [("run-help", "man"), ("which-command", "whence")] {
				k.root.set_record(
					cx.store,
					KeyBuf::Alias(name.into()),
					Some(Record::Alias(text.into())),
				);
			}
			if let Some(err) = k.root.take_fault() {
				return Err(ShellError::Store(err));
			}
		}
		if init.interactive {
			jobctl::init_io(&mut k, cx, &mut root);
			if let Some(err) = k.root.take_fault() {
				return Err(ShellError::Store(err));
			}
			// zsh `init_io`: an interactive shell with its terminal uses
			// the line editor, unless the command line turned it off.
			let zle = crate::bash::zshopt::ZshOpt::Zle;
			let off = zsh_options.iter().any(|&(o, on)| o == zle && !on);
			if zsh && !off && jobctl::shtty_file(&k).is_some() {
				state::set_zsh_option(&mut k.root, cx.store, &mut root, zle, true)
					.map_err(ShellError::Store)?;
			}
		}
		Ok(Self {
			k,
			procs: vec![Box::new(root)],
			rr: 0,
			slice: None,
			gone: Vec::new(),
			orphans: Vec::new(),
			taking_in: Vec::new(),
			fresh: Vec::new(),
		})
	}

	/// Rebind the root's standard streams to the host's current streams,
	/// including any higher-numbered duplicates of those streams.
	pub(crate) fn reset_root_stdio(&mut self, host: &mut dyn Host) {
		let fresh = host_stdio(host, &mut [None, None, None]);
		let fds = &mut self.procs[0].fds;
		for fd in 3..fds.slots().len() {
			if let Some(FdOrigin::Std(stream)) = fds.get(fd as i32).map(FdRef::origin) {
				fds.set(fd as i32, fresh.get(stream.fd()).cloned());
			}
		}
		for fd in 0..3 {
			fds.set(fd, fresh.get(fd).cloned());
		}
	}

	/// Queue a script; see [`VprocSel`] for where it runs. A new subshell
	/// starts from the shell's global state: it does not see the locals of
	/// a function the shell is in the middle of (a host submits between
	/// steps, at no particular point of the root's execution).
	pub fn submit(&mut self, script: Script) -> RunId {
		self.submit_from(0, script, None, None)
	}

	/// [`Self::submit`] for the vproc at `parent` (`ShellApi::run_subshell`
	/// passes its store: the new subshell sees the caller's function
	/// scopes). A new subshell vproc gets `lineage`, or else the parent's.
	/// The new vproc is adopted, and its `Record::Proc` written, at the next
	/// scheduler turn.
	fn submit_from(
		&mut self,
		parent: usize,
		script: Script,
		mut store: Option<&mut dyn StateStore>,
		lineage: Option<crate::bash::host::Lineage>,
	) -> RunId {
		let id = RunId(self.k.next_run);
		self.k.next_run += 1;
		let mode = script.mode.unwrap_or(self.procs[parent].mode);
		let mut run = Run {
			id,
			tag: script.tag,
			src: script.source,
			chain: OriginChain { links: vec![OriginLink { origin: script.origin, at: None }] },
			mode,
			restore_mode: None,
			explicit_mode: script.mode.is_some(),
			lossy: 0,
			args: None,
			cwd: None,
			env: Vec::new(),
			started: false,
			exit_trap_started: false,
			too_long_to_host: script.too_long_to_host,
			refusals_to_host: script.refusals_to_host,
			callout: false,
		};
		let stdio = match script.vproc {
			VprocSel::Root => {
				run.args = script.args;
				run.cwd = script.cwd;
				run.env = script.env;
				self.procs[0].runs.push_back(run);
				return id;
			},
			VprocSel::NewSubshell => None,
			VprocSel::NewSubshellWithStdio(stdio) => Some(stdio),
		};
		// No vpid left ([`Vpid::CEILING`]): the run ends at once with bash's
		// fork-failure status, and nothing is built.
		if self.k.vpids_left() == 0 {
			self.k.done.push_back((id, 254));
			return id;
		}
		let mut edits = ForkEdits {
			env:          script.env,
			foreign_env:  script.foreign_env,
			unexport_env: script.unexport_env,
			args:         script.args,
			exported:     Vec::new(),
			as_program:   script.as_program,
		};
		let p = &self.procs[parent];
		// The caller's exported functions reach a program's children in its
		// environment alone (`Script::as_program` hides the functions).
		if script.as_program
			&& let Some(store) = store.as_deref_mut()
			&& let Err(err) = command::exported_functions(store, p, &mut edits.exported)
		{
			self.k.root.fail(err);
		}
		let mut fds = p.fds.clone();
		if let Some(stdio) = stdio {
			for (fd, s) in stdio.into_iter().enumerate() {
				match s {
					RunStdio::Inherit => {},
					RunStdio::Closed => fds.set(fd as i32, None),
					RunStdio::File(f) => fds.set(fd as i32, Some(FdRef::open(f, FdOrigin::Host))),
				}
			}
		}
		let cwd = script.cwd.unwrap_or_else(|| p.cwd.clone());
		let status = p.status;
		// A copy of the parent's `$RANDOM` generator and `$SECONDS` origin,
		// as a fork makes (`Vproc::child_running`).
		let clock = self.k.fork_clock(p);
		// The parent's asynchronous ignore ([`Vproc::async_ignored`]) comes
		// with the traps the child's image copies.
		let async_ignored = p.async_ignored;
		// The parent's global state now; a host's submission (no store) to
		// the root takes it when the scheduler adopts the subshell, before
		// the root runs again.
		let base = match store {
			Some(store) => {
				let image = state::fork_image(&self.k.root, store, p);
				let scopes = state::copy_scopes(&self.k.root, store, p);
				match image.and_then(|image| Ok((image, scopes?))) {
					Ok(base) => Some(base),
					Err(err) => {
						self.k.root.fail(err);
						Some(((Image::default(), None), Vec::new()))
					},
				}
			},
			None => p
				.image
				.clone()
				.map(|image| ((image, p.locale_gen), p.scopes.clone())),
		};
		let parent_vpid = p.vpid;
		// Written as `MiscKey::NextVpid` before the next step returns
		// (`Kernel::sync_root`). The caller checked `vpids_left`.
		debug_assert!(
			self.k.next_vpid <= Vpid::CEILING,
			"no vpid left: the caller checks vpids_left"
		);
		let vpid = Vpid(self.k.next_vpid);
		self.k.next_vpid = self.k.next_vpid.saturating_add(1);
		let parent_lineage = self.procs[parent].lineage;
		let mut vp = Vproc::new(vpid, Some(parent_vpid), fds, cwd, Some(Image::default()), true);
		vp.lineage = lineage.unwrap_or(parent_lineage);
		vp.status = status;
		vp.async_ignored = async_ignored;
		vp.mode = mode;
		vp.clock = Some(clock);
		vp.runs.push_back(run);
		match base {
			Some(((image, locale_gen), scopes)) => {
				vp.image = Some(image);
				vp.locale_gen = locale_gen;
				vp.scopes = scopes;
				edits.apply(&mut vp);
			},
			None => self.k.pending_forks.push((vpid, edits)),
		}
		self.k.spawned.push(Box::new(vp));
		id
	}

	/// Another writer changed the store since the engine last looked:
	/// drop what the engine derived from it and re-read the root vproc's
	/// working directory (a TS tool may have moved the shell). Called at
	/// every engine entry that runs or inspects shell code (`step`, `api`,
	/// `externalize`).
	fn see_epoch(&mut self, cx: &mut Cx<'_>) {
		let epoch = cx.store.epoch();
		if epoch == self.k.root.epoch() {
			return;
		}
		self.k.root.invalidate(cx.store, epoch);
		match state::root_misc(cx.store, MiscKey::Cwd) {
			Ok(Some(cwd)) => {
				let cwd = BString::from(cwd);
				self.procs[0].cwd = cwd;
			},
			Ok(None) => {},
			Err(err) => self.k.fail(err),
		}
		// The root's mode too (a copied or restored store).
		match state::root_misc(cx.store, MiscKey::Mode) {
			Ok(Some(m)) => {
				if let Some(mode) = std::str::from_utf8(m).ok().and_then(|m| m.parse().ok()) {
					self.procs[0].mode = mode;
				}
			},
			Ok(None) => {},
			Err(err) => self.k.fail(err),
		}
	}

	/// Run up to `budget` of work; see [`Step`]. Before it returns, the
	/// store holds every change the step made (`Kernel::sync_root` writes
	/// the root vproc's in-place fields).
	pub fn step(&mut self, cx: &mut Cx<'_>, budget: Budget) -> Step {
		self.see_epoch(cx);
		// Subshells a host submitted since the last step.
		self.adopt(cx);
		self.settle_callouts();
		let step = self.step_inner(cx, budget);
		self.k.sync_root(cx.store, &mut self.procs[0]);
		step
	}

	fn step_inner(&mut self, cx: &mut Cx<'_>, budget: Budget) -> Step {
		let start = cx.host.now_ns();
		let mut ops = 0u32;
		loop {
			// The shell's job notices go out as its terminal takes them, also
			// while the shell waits for a job (zsh `notify`); the terminal's
			// writer thread wakes the kernel when it is done with a chunk.
			jobctl::drain_shout(&mut self.k);
			if let Some(err) = self.k.root.take_fault() {
				self.fail_all(cx, &err);
			}
			// The orphans of subshells a signal ended (`apply_requests`), or
			// that a restore found; before `report`, which tells of the runs
			// ending them ended.
			if !self.k.paused {
				self.end_orphans(cx, None);
			}
			if let Some(step) = self.report() {
				return step;
			}
			// A substitution's output read to its end while its reader held an
			// `INT` ([`HeldInt::Comsub`]).
			if !self.k.int_notes.is_empty() {
				self.comsub_reads_ended();
			}
			if self.k.ctl.word() != 0 {
				if let Some(step) = self.apply_requests(cx) {
					return step;
				}
				continue;
			}
			if self.k.paused {
				self.k.ctl.park(self.k.ctl.wakes());
				return Step::Paused;
			}
			if !self.procs.iter().any(|p| p.has_work()) {
				return Step::Idle;
			}
			let wakes = self.k.ctl.wakes();
			let cont = self.slice.and_then(|(vpid, left)| {
				let i = self.procs.iter().position(|p| p.vpid == vpid)?;
				self.runnable(i, wakes).then_some((i, left))
			});
			let Some((i, left)) = cont.or_else(|| self.pick(wakes).map(|i| (i, SLICE))) else {
				self.slice = None;
				self.k.ctl.park(wakes);
				return Step::Blocked;
			};
			// `Yield` means runnable work is left: checked after `pick`.
			if ops >= budget.max_ops || cx.host.now_ns().saturating_sub(start) >= budget.max_ns {
				return Step::Yield;
			}
			if cont.is_none() {
				self.rr = (i + 1) % self.procs.len();
			}
			let slice = left.min(budget.max_ops - ops).max(1);
			let before = ops;
			exec::run_slice(&mut self.k, &mut self.procs[i], cx, slice, &mut ops);
			let used = ops - before;
			let p = &self.procs[i];
			let ran = p.vpid;
			self.fresh.retain(|&v| v != ran);
			self.slice = (used < left && p.has_work() && p.blocked.is_none() && !p.stopped)
				.then_some((ran, left - used));
			self.adopt(cx);
			self.end_orphans(cx, Some(ran));
			if !self.k.bangs.is_empty() {
				self.decide_waited_bangs(ran, used);
			}
			self.job_events(cx);
			if !self.k.exits_asked.is_empty() || !self.taking_in.is_empty() {
				self.take_in_exits(ran);
			}
		}
	}

	/// Move children created during the turn into the scheduler and reap
	/// subshell vprocs that finished.
	fn adopt(&mut self, cx: &mut Cx<'_>) {
		for (vpid, edits) in std::mem::take(&mut self.k.pending_forks) {
			let base = state::fork_image(&self.k.root, cx.store, &self.procs[0]);
			let Some(vp) = self.k.spawned.iter_mut().find(|p| p.vpid == vpid) else {
				continue;
			};
			let (image, locale_gen) = base.unwrap_or_else(|err| {
				self.k.root.fail(err);
				(Image::default(), None)
			});
			vp.image = Some(image);
			vp.locale_gen = locale_gen;
			edits.apply(vp);
		}
		for p in &self.k.spawned {
			// A job `disown` dropped before it got here is no child.
			let parent = p.parent.filter(|_| !self.k.disowned.contains(&p.vpid));
			let rec = Record::Proc { parent, status: None };
			self
				.k
				.root
				.write(cx.store, Change::Put(Key::Proc(p.vpid), rec));
		}
		self.fresh.extend(self.k.spawned.iter().map(|p| p.vpid));
		self.procs.append(&mut self.k.spawned);
		self.k.disowned.clear();
		self.apply_settled();
		let mut i = 0;
		while i < self.procs.len() {
			// A job that has ended (no run and no frame left) still deciding its
			// pid, with signals `kill` held for it, takes them first
			// ([`Kernel::take_held`]): what it queued waits for them, whatever
			// it still has to write.
			let ended = self.procs[i].runs.is_empty() && self.procs[i].frames.is_empty();
			if self.procs[i].transient
				&& ended
				&& !self.k.bangs.is_empty()
				&& self.k.take_held(self.procs[i].vpid)
			{
				i += 1;
				continue;
			}
			let p = &self.procs[i];
			// A subshell vproc exits once its frames are done and its
			// diagnostics are out ([`proc::Vproc::has_work`]).
			if p.transient && !p.has_work() {
				let p = self.procs.remove(i);
				self.k.trace_sources.remove(&p.vpid);
				self.k.trace_unit_origins.remove(&p.vpid);
				jobctl::forget_vproc(&mut self.k, p.vpid);
				// A job that ended undecided keeps its virtual pid.
				self.k.settle_bang(p.vpid, None);
				self.k.forget_deferral(p.vpid);
				self.k.proc_exited(cx.store, p.vpid, p.parent, p.status);
				self.k.ctl.notify();
				self.rr = 0;
				// A subshell the parent ran in place of itself died with the
				// command it ran in place: so does the parent's process.
				if let (true, Some(signal)) = (p.in_place(), p.died_of())
					&& let Some(parent) = self.procs.iter_mut().find(|q| Some(q.vpid) == p.parent)
				{
					match parent.runs.front().map(|run| run.id) {
						Some(run) if parent.parent.is_none() => {
							self.k.exec_signals.insert(run, signal);
						},
						_ if parent.in_place() => parent.zsh_state().died_of = Some(signal),
						_ => {},
					}
				}
				// Its traps were the process's: the parent's come back.
				if p.in_place()
					&& let Some(parent) = self.procs.iter().find(|q| Some(q.vpid) == p.parent)
					&& (parent.parent.is_none() || parent.in_place())
				{
					untrapped::in_place_ended(&mut self.k, cx, parent);
				}
				let died = self.k.died_of(p.vpid);
				self.k.set_int_note(p.vpid, None);
				self.k.frozen_ints.retain(|v| *v != p.vpid);
				self.k.held_notices.retain(|(v, ..)| *v != p.vpid);
				self.ended(p.vpid, p.parent);
				self.reaped(cx, p.parent, p.vpid, p.status, died, false);
			} else {
				i += 1;
			}
		}
	}

	/// Write the OS pids jobs and processes settled on during the turn
	/// ([`Kernel::settled`]) into every job table listing them (the
	/// parent's, a command substitution's copies), every `$!` naming them,
	/// and the records of the processes of jobs and of the pipelines vprocs
	/// wait for ([`proc::JobProc`]). A job a `kill` before the decision
	/// marked as ended with no program ([`proc::Job::unreaped`]) has one now:
	/// its end comes as the host reaps it.
	fn apply_settled(&mut self) {
		for (job, pid) in std::mem::take(&mut self.k.settled) {
			for p in &mut self.procs {
				if p.last_bg.is(job) {
					p.last_bg.set_os(pid);
				}
				if let Some(entry) = p.jobs.by_vpid_mut(job) {
					entry.os_pid = Some(pid);
					entry.unreaped = false;
				}
				p.jobs.proc_settled(job, pid);
				let waited = p
					.frames
					.iter_mut()
					.filter_map(|f| f.scratch.as_deref_mut())
					.find_map(|sc| sc.process_mut(job));
				if let Some(q) = waited {
					q.os_pid = Some(pid);
				}
			}
		}
	}

	/// Builtins about to report job state asked to take in the exits
	/// already available first ([`Kernel::exits_asked`]): bash's job states
	/// follow its children's exits at once (`waitchld`, run by its
	/// `SIGCHLD` handler), before a builtin reads them. The asker is
	/// answered ([`Kernel::exits_taken`]) once every other vproc that had
	/// work when it asked has had its next turn of the round-robin, and the
	/// parent of each of those that ended since one turn more
	/// ([`Self::ended`]): a vproc that waits for an exited program or for
	/// ended children polls again and takes the end in, and an end climbs
	/// its job. Waking every parked vproc at the ask makes each of them
	/// runnable; until the answer the asker parks again whenever it runs. A
	/// job the asker started that has not had a turn yet ([`Self::fresh`])
	/// has not run, so it has no exit to take in and is owed nothing:
	/// `{ exit 3; } & jobs` lists the job `Running`, as bash does when its
	/// child has not ended yet.
	///
	/// Nothing runs out of turn, so the round-robin's fairness is the one
	/// the scheduler has without a take-in: only the asker waits, for at
	/// most two turns of each of the `n` vprocs it saw (`2n`); one that runs
	/// on parks or runs on, and is not waited for. An owed vproc that cannot
	/// run (stopped, gone, out of work) owes nothing. An owed vproc is never
	/// parked here: the ask wakes every parked vproc, a vproc leaves `owed`
	/// at its turn, and the end that owes a parent its turn wakes it too.
	///
	/// An ask stays in [`Kernel::exits_asked`] until it is answered or the
	/// builtin withdraws it ([`Kernel::withdraw_exits`]); a gone asker asks
	/// no more. Until its builtin has used the answer ([`Kernel::asking`]),
	/// no signal trap starts in the asker (`exec::run_slice`): its command
	/// still runs, with its redirections, and the trap runs once that
	/// command is over, as bash runs a trap between commands.
	fn take_in_exits(&mut self, ran: Vpid) {
		for t in &mut self.taking_in {
			t.owed.retain(|&v| v != ran);
		}
		let procs = &self.procs;
		self
			.k
			.exits_asked
			.retain(|&v| procs.iter().any(|p| p.vpid == v));
		let asking = &self.k.exits_asked;
		self.taking_in.retain(|t| asking.contains(&t.asker));
		let mut asked = false;
		for &asker in &self.k.exits_asked {
			if self.taking_in.iter().any(|t| t.asker == asker) {
				continue;
			}
			let seen: Vec<Vpid> = self
				.procs
				.iter()
				.filter(|p| {
					p.vpid != asker
						&& p.has_work()
						&& !p.stopped
						&& !(p.parent == Some(asker) && self.fresh.contains(&p.vpid))
				})
				.map(|p| p.vpid)
				.collect();
			self
				.taking_in
				.push(TakeIn { asker, owed: seen.clone(), seen });
			asked = true;
		}
		if asked {
			// Parked vprocs poll again: each owed one is runnable.
			self.k.ctl.notify();
		}
		let mut answered = Vec::new();
		let procs = &self.procs;
		self.taking_in.retain(|t| {
			let owing = t.owed.iter().any(|&v| {
				procs
					.iter()
					.any(|p| p.vpid == v && p.has_work() && !p.stopped)
			});
			if !owing {
				answered.push(t.asker);
			}
			owing
		});
		if answered.is_empty() {
			return;
		}
		self.k.exits_asked.retain(|v| !answered.contains(v));
		self
			.k
			.exits_taken
			.retain(|&v| self.procs.iter().any(|p| p.vpid == v));
		// Each asker answered is one still here: its take-in is one of
		// `exits_asked`, which keeps only those.
		self.k.exits_taken.extend(answered);
		// The askers are parked: they run again.
		self.k.ctl.notify();
	}

	/// Vproc `vpid`, a child of `parent`, ended: a take-in that saw it owes
	/// its parent one turn more, in which the parent takes the end in
	/// ([`Self::take_in_exits`]).
	fn ended(&mut self, vpid: Vpid, parent: Option<Vpid>) {
		self.fresh.retain(|&v| v != vpid);
		let Some(parent) = parent else {
			return;
		};
		for t in &mut self.taking_in {
			t.owed.retain(|&v| v != vpid);
			if t.seen.contains(&vpid) && parent != t.asker && !t.owed.contains(&parent) {
				t.owed.push(parent);
			}
		}
	}

	/// A background job's lone command was a host callout
	/// ([`proc::BangStage::Callout`]) the host has seen: unless it handed
	/// the job to a subshell meanwhile
	/// ([`ShellApi::exec_subshell_in`]), the job keeps its virtual pid.
	/// Called when the host steps the shell again.
	fn settle_callouts(&mut self) {
		let seen: Vec<Vpid> = self
			.k
			.bangs
			.iter()
			.filter(|b| {
				b.stage == proc::BangStage::Callout
					&& !self
						.k
						.calls_out
						.iter()
						.any(|(_, call)| call.vpid == b.vproc)
			})
			.map(|b| b.vproc)
			.collect();
		for vproc in seen {
			self.k.settle_bang(vproc, None);
		}
	}

	/// A reader of a background job's pid (`$!`, `jobs -p`, the job's
	/// `[n] pid` line, a `wait` for it) parks until the job decides it
	/// ([`proc::Bang`]). The job keeps its virtual pid once it would make
	/// that reader wait: when what decides it is stopped, or waits for
	/// anything but an in-engine child of its own (a command substitution,
	/// a subshell), a program's launch or its own filesystem answer (a
	/// child's, such as a FIFO open, is a wait: [`Self::bang_waits`]); or when
	/// it has run a scheduler slice ([`SLICE`] ops) since the reader parked,
	/// so a job that runs without end never holds the reader. Until then
	/// the job runs on and may still `exec` its program, which gives it the
	/// program's OS pid, as bash's forked child is known by its pid at once.
	/// `ran` just ran `used` ops.
	fn decide_waited_bangs(&mut self, ran: Vpid, used: u32) {
		let mut i = 0;
		while let Some(&bang) = self.k.bangs.get(i) {
			let read = bang.stage != proc::BangStage::Callout
				&& self.procs.iter().any(|p| {
					p.blocked
						.as_ref()
						.is_some_and(|b| b.key == WaitKey::Proc(bang.job))
				});
			if !read {
				i += 1;
				continue;
			}
			let (waits, on_its_way) = self.bang_waits(bang.vproc, ran);
			let spent = if let Some(at) = self.k.bang_spent.iter().position(|&(j, _)| j == bang.job) {
				&mut self.k.bang_spent[at].1
			} else {
				self.k.bang_spent.push((bang.job, 0));
				&mut self.k.bang_spent.last_mut().expect("just pushed").1
			};
			if on_its_way {
				*spent = spent.saturating_add(used);
			}
			if waits || *spent >= SLICE {
				// It leaves `bangs`: index `i` now holds the next one.
				self.k.settle_bang(bang.vproc, None);
			} else {
				i += 1;
			}
		}
	}

	/// Whether `vproc`, which decides a job's pid, would wait (it is
	/// stopped, or parked on anything but an in-engine child that is not
	/// waiting itself, a program's launch or its own filesystem answer; a
	/// cycle of vprocs parked on each other waits too), and whether `ran`
	/// is on its way: `vproc` or a child it waits for, transitively. (Only
	/// the job's own program can be launching: any other decides when it
	/// starts, `bang_dispatch`.) A child's filesystem wait (a command
	/// substitution, subshell, pipeline stage or job of the job's own) is a
	/// wait: outside obash's pending-fs test mode only a FIFO open or read
	/// pends, and it may wait for what the shell does after it reads `$!`.
	/// The job's own FIFO opens and reads decide where they are made
	/// (`redir::defer`, zsh's redirections, `.`).
	fn bang_waits(&self, vproc: Vpid, ran: Vpid) -> (bool, bool) {
		let mut v = vproc;
		let mut on_its_way = false;
		for _ in 0..=self.procs.len() {
			on_its_way |= v == ran;
			let Some(p) = self.procs.iter().find(|p| p.vpid == v) else {
				return (false, on_its_way);
			};
			if p.stopped {
				return (true, on_its_way);
			}
			match p.blocked.as_ref().map(|b| &b.key) {
				None | Some(WaitKey::Spawn { .. }) => return (false, on_its_way),
				Some(WaitKey::Fs { .. }) => return (v != vproc, on_its_way),
				Some(WaitKey::Proc(child)) => v = *child,
				Some(_) => return (true, on_its_way),
			}
		}
		(true, on_its_way)
	}

	/// Child vproc `vpid` of `parent` ended with `status` (`died_of`: by
	/// that signal, [`Kernel::deaths`]): the record of that process of a
	/// pipeline says so ([`Self::process_ended`]), the parent's job for it is
	/// done and keeps how it ended ([`proc::Job::ended`]: `jobs`, `wait` see
	/// it, and the notice of a job a signal killed, [`killed::waited`],
	/// [`killed::line_read`]: by the signal that ended the process whose end
	/// is the job's status, of a pipeline's job [`proc::Job::procs`]; of a job
	/// without those, the signal that ended its vproc), a foreground subshell
	/// a signal killed gets its notice (not when `pipeline`, a signal ended
	/// it as it ran a pipeline, [`runs_pipeline`]), a
	/// parent trapping `SIGCHLD` owes one more run of the trap for each
	/// process that ended (bash's `waitchld` counts each child it reaps: a
	/// pipeline job's own vproc is none of bash's processes, so its end owes
	/// a run only for each process of the job that ended with it; each other
	/// one owed its run as the job's vproc reaped it, [`Self::process_ended`];
	/// zsh runs the trap once per job, [`owe_chld`]), and one holding an
	/// `INT` for its foreground job learns how this process of it ended (bash
	/// `waitchld`'s `child_caught_sigint`, [`HeldInt::Job`]).
	fn reaped(
		&mut self,
		cx: &mut Cx<'_>,
		parent: Option<Vpid>,
		vpid: Vpid,
		status: i32,
		died_of: Option<Signal>,
		pipeline: bool,
	) {
		// Its own children are orphans now.
		if self.k.engine.config().end_orphan_jobs {
			self.gone.push(vpid);
		}
		let Some(i) = parent.and_then(|v| self.procs.iter().position(|p| p.vpid == v)) else {
			return;
		};
		let owner = self.process_ended(i, vpid, proc::ProcState::ended(status, died_of));
		// bash's foreground job of it ([`proc::Job::foreground`]) is done
		// once it, or each process of the pipeline it is a stage of, ended.
		// bash's wait for it marks it reported where the list only marks
		// (`notify_and_cleanup` under -1), but not a `lastpipe` pipeline's,
		// which it waits for with the list still frozen.
		if self.procs[i].jobs.iter().any(|j| j.foreground) {
			let p = &self.procs[i];
			let inline = p
				.frames
				.last()
				.and_then(|f| f.scratch.as_deref())
				.is_some_and(|sc| sc.inline().is_some());
			let notified = !inline && p.freeze() == proc::Freeze::Marks;
			let platform = self.k.engine.config().platform;
			let end = proc::ProcState::ended(status, died_of);
			self.procs[i]
				.jobs
				.foreground_reaped(vpid, end, status, pipeline, notified, platform);
		}
		let job = self.procs[i].jobs.by_vpid_mut(vpid);
		let background = job.is_some();
		// The runs of the `CHLD` trap this end owes: one for the process it
		// is, or one for each process of its pipeline job that ended with it.
		let mut owed = 1;
		if let Some(job) = job {
			let with_it = job.ended(status, died_of);
			if job.procs.is_some() {
				owed = with_it;
			}
		}
		let parent = self.procs[i].vpid;
		if !background && let Some(IntNote::Held(HeldInt::Job { .. })) = self.k.int_note(parent) {
			let caught = died_of != Some(Signal::Int);
			self
				.k
				.set_int_note(parent, Some(IntNote::Held(HeldInt::Job { caught })));
		}
		if let (false, Some(sig)) = (background, died_of) {
			// bash runs a `( … )` that is the whole command of a `( … )`, a
			// job or a stage in that process (`CMD_NO_FORK`): the process dies
			// of the signal too, and its own parent reports it.
			if waits_for_its_subshell(&self.procs[i]) {
				self.k.dies_of(parent, sig);
			} else if !pipeline {
				// A foreground subshell that died of a signal gets a notice.
				killed::subshell_ended(&mut self.k, cx, &mut self.procs[i], vpid, sig);
			}
		}
		jobctl::job_done(&mut self.k, cx, &mut self.procs[i], vpid);
		// bash reaped every child that had ended as it waited for this
		// foreground one ([`proc::Job::unreaped`]).
		if !background {
			self.procs[i].jobs.all_reaped();
		}
		if self.procs[i].mode.dialect() == crate::bash::ids::Dialect::Zsh {
			owed = 1;
		}
		for _ in 0..owed {
			owe_chld(&mut self.k, cx, &mut self.procs[i], background.then_some(vpid));
		}
		// A process of a pipeline job, reaped by the job's vproc: bash's
		// parent of the job reaps it (zsh owes none for it, [`owe_chld`]).
		if let Some(s) = owner {
			owe_chld(&mut self.k, cx, &mut self.procs[s], None);
		}
	}

	/// Child `vpid` of vproc `i` ended as `end`: the record of that process
	/// of a pipeline says so ([`proc::JobProc`]), of one `i` waits for
	/// ([`proc::PipelineWait::procs`]) or of the one that is the whole
	/// command of the job `i` is the vproc of ([`proc::Job::procs`], in its
	/// parent's table). Returns that parent, in the last case.
	fn process_ended(&mut self, i: usize, vpid: Vpid, end: proc::ProcState) -> Option<usize> {
		let p = &mut self.procs[i];
		let waited = p
			.frames
			.iter_mut()
			.rev()
			.filter_map(|f| f.scratch.as_deref_mut())
			.find_map(|sc| sc.process_mut(vpid));
		if let Some(q) = waited {
			q.state = end;
			return None;
		}
		let job = p.vpid;
		let s = p
			.parent
			.and_then(|v| self.procs.iter().position(|q| q.vpid == v))?;
		let q = self.procs[s]
			.jobs
			.by_vpid_mut(job)
			.and_then(|j| j.procs.as_deref_mut())
			.and_then(|procs| procs.get_mut(vpid))?;
		q.state = end;
		Some(s)
	}

	/// Vproc `vpid` stopped (`Some(signal)`) or continued (`None`). If it
	/// leads a job, or is a process of a pipeline job ([`proc::Job::procs`]),
	/// the job's state follows, as bash's `waitchld` does: a stop makes the
	/// job current (`set_current_job`), a stopped job that continues makes
	/// bash `reset_current`; one `bg` or `kill -CONT` already marked running
	/// is left alone. A pipeline job's state follows its processes: it stops
	/// once none of them runs, and runs again once one does
	/// ([`proc::Job::process_changed`]). Its own vproc is none of bash's
	/// processes: its stop or continue reaches those it has not started yet
	/// (no vproc has their vpids), which bash forked with the job. Without job
	/// control bash never learns of stops (`waitpid` without `WUNTRACED`): the
	/// job stays running. zsh always waits with `WUNTRACED`: its jobs show
	/// stops with or without `MONITOR`.
	fn job_changed(&mut self, cx: &mut Cx<'_>, vpid: Vpid, stop: Option<Signal>) {
		// The owner's entry, not a subshell's copy of it.
		let is_its = |j: &proc::Job| {
			!j.inherited
				&& (j.vpid == vpid
					|| j
						.procs
						.as_deref()
						.is_some_and(|procs| procs.list.iter().any(|q| q.vpid == vpid)))
		};
		let Some(i) = self.procs.iter().position(|p| p.jobs.iter().any(is_its)) else {
			return;
		};
		let p = &self.procs[i];
		if p.jobs.subshell
			|| (p.mode.dialect() != crate::bash::ids::Dialect::Zsh
				&& !state::option(&mut self.k.root, cx.store, p, OptId::Monitor).unwrap_or(false))
		{
			return;
		}
		let Some(job) = p.jobs.iter().find(|j| is_its(j)) else {
			return;
		};
		let number = job.number;
		// The processes of a pipeline job the change reaches.
		let reached: Option<Vec<Vpid>> = job.procs.as_deref().map(|procs| {
			if job.vpid == vpid {
				let live = |v: Vpid| self.procs.iter().any(|r| r.vpid == v);
				procs
					.list
					.iter()
					.map(|q| q.vpid)
					.filter(|&v| !live(v))
					.collect()
			} else {
				vec![vpid]
			}
		});
		let p = &mut self.procs[i];
		let zsh = p.mode.dialect() == crate::bash::ids::Dialect::Zsh;
		let Some(job) = p.jobs.get_mut(number) else {
			return;
		};
		if let Some(reached) = reached {
			let was = job.state;
			for v in reached {
				job.process_changed(v, stop);
			}
			let now = job.state;
			if now != was {
				job.notified = false;
				if matches!(now, proc::JobState::Stopped(_)) {
					jobctl::stopped_current(p, number);
				} else if !zsh {
					p.jobs.reset_current();
				}
			}
			return;
		}
		match (stop, job.state) {
			(_, proc::JobState::Done(_)) => {},
			(Some(sig), _) => {
				job.state = proc::JobState::Stopped(sig);
				job.notified = false;
				jobctl::stopped_current(p, number);
			},
			(None, proc::JobState::Stopped(_)) => {
				job.state = proc::JobState::Running;
				job.notified = false;
				// zsh leaves the current job alone (`update_job`).
				if !zsh {
					p.jobs.reset_current();
				}
			},
			(None, proc::JobState::Running) => {},
		}
	}

	/// Next vproc to run, round-robin: has work, not stopped, not parked at
	/// the current wake count.
	fn pick(&self, wakes: u64) -> Option<usize> {
		let n = self.procs.len();
		(0..n)
			.map(|off| (self.rr + off) % n)
			.find(|&i| self.runnable(i, wakes))
	}

	/// Vproc `i` has work and is neither stopped nor waiting for a wake that
	/// has not come.
	fn runnable(&self, i: usize, wakes: u64) -> bool {
		let p = &self.procs[i];
		p.has_work() && !p.stopped && p.blocked.as_ref().is_none_or(|b| b.at != wakes)
	}

	/// A finished script or an outgoing callout, if any.
	fn report(&mut self) -> Option<Step> {
		if let Some((run, status)) = self.k.done.pop_front() {
			self.k.reported_signal = self.k.exec_signals.remove(&run).map(|signal| (run, signal));
			self.k.reported_refusal = self
				.k
				.exec_refusals
				.remove(&run)
				.map(|refusal| (run, refusal));
			return Some(Step::Done { run, status });
		}
		let (id, call) = self.k.calls_out.pop_front()?;
		Some(Step::Call { id, call })
	}

	/// Apply pending control requests.
	fn apply_requests(&mut self, cx: &mut Cx<'_>) -> Option<Step> {
		let mut req = self.k.ctl.take();
		// The OS signals a handler caught while shell code ran: the host
		// queues them now ([`ControlHandle::signal_word`]).
		if req & OS_SIGNAL != 0 {
			cx.host.forward_signals();
			req |= self.k.ctl.take();
		}
		if req & (CANCEL | SIGNAL) != 0 {
			// A cancel or signal concerns blocked vprocs too: let them run
			// (pause/resume deliberately do not).
			self.k.ctl.notify();
		}
		if req & CANCEL != 0 {
			let sig = self.k.ctl.cancel_signal();
			let status = sig.exit_status(self.k.engine.config().platform);
			if self.procs[0].runs.front().is_some_and(|run| !run.started) {
				// The cancelled script has not started: it started no job.
				self.k.note_prior_jobs(&self.procs[0]);
			}
			// A detached tree (`nohup`) outlives the cancellation, and so does
			// a background job an earlier script left running: it is no part
			// of the cancelled command, as bash's interrupt reaches only the
			// foreground job.
			let spared: Vec<Vpid> = self
				.procs
				.iter()
				.filter(|p| p.lineage.detached || self.in_prior_job(p.vpid))
				.map(|p| p.vpid)
				.collect();
			for i in (0..self.procs.len()).rev() {
				if spared.contains(&self.procs[i].vpid) {
					continue;
				}
				// Its builtin parked on a take-in never runs again.
				let vpid = self.procs[i].vpid;
				self.drop_take_in(vpid);
				let key = crate::bash::store::TrapKey::Signal(sig);
				// Only a vproc with code left runs a trap: one that has ended
				// and only writes its last message has nowhere to run it.
				let trapped = sig != Signal::Kill
					&& self.procs[i].has_code()
					&& exec::start_trap(&mut self.k, &mut self.procs[i], cx, key);
				// bash runs the EXIT trap when a signal ends it: an untrapped
				// TERM/INT/… ends the shell's own vprocs through it too.
				let unwinds = trapped
					|| (sig != Signal::Kill && self.procs[i].has_code() && !self.procs[i].transient);
				if unwinds {
					// A spawn still pending never starts: the cancelled command
					// is not resumed (the trap is the last action).
					for frame in &mut self.procs[i].frames {
						if let Some(sc) = frame.scratch.as_mut()
							&& matches!(sc.live, Live::Spawn(_))
						{
							sc.live = Live::None;
						}
					}
					signal_lives(&mut self.procs[i], sig, true);
					self.procs[i].stopped = false;
					if trapped {
						exec::mark_cancel(&mut self.procs[i], status);
					} else {
						exec::finish_cancel(&mut self.k.root, cx.store, &mut self.procs[i], status);
					}
				} else {
					self.kill(cx, i, sig, status);
				}
			}
			// The root's process runs no program in place of the shell now: a
			// pending spawn went, and the program got the signal.
			untrapped::program_ended(&mut self.k, cx, &self.procs[0]);
			// Calls of the cancelled vprocs are void; the spared ones' go on.
			let kept: Vec<CallId> = self
				.k
				.results
				.keys()
				.copied()
				.filter(|&id| {
					self
						.awaiting(id)
						.is_some_and(|i| spared.contains(&self.procs[i].vpid))
				})
				.collect();
			self
				.k
				.calls_out
				.retain(|(_, call)| spared.contains(&call.vpid));
			self.k.results.retain(|id, _| kept.contains(id));
			self.k.paused = false;
		}
		if req & SIGNAL != 0 {
			let (signals, first) = self.k.ctl.take_signals();
			for (n, (target, sig)) in (first..).zip(signals) {
				self.deliver(cx, target, sig, n);
			}
		}
		if req & PAUSE != 0 && !self.k.paused {
			self.set_paused(cx, true);
		}
		if req & RESUME != 0 && self.k.paused {
			self.set_paused(cx, false);
		}
		if req & SUSPEND != 0 {
			for p in &mut self.procs {
				for f in &mut p.frames {
					if let Some(sc) = f.scratch.as_mut()
						&& sc.live.is_idempotent_fs()
					{
						// Dropping requests cancellation; the stage re-issues it.
						sc.live = Live::None;
						p.blocked = None;
						self.k.dropped_fs += 1;
					}
				}
			}
			let root = (self.procs[0].vpid, self.procs[0].mode);
			self.k.emit(cx, root, None, EventData::Suspended);
			return Some(Step::SuspendReady);
		}
		None
	}

	/// Terminate vproc `i` with `status`: signal its task or external, end its
	/// scripts. Transient vprocs are removed. One with a parent died of `sig`
	/// ([`Kernel::deaths`]), though an `INT` began its end (its EXIT trap,
	/// which the signal ends).
	fn kill(&mut self, cx: &mut Cx<'_>, i: usize, sig: Signal, status: i32) {
		self.end(cx, i, sig, status, true);
	}

	/// [`Self::kill`], `externals`: signalling its externals too; else they
	/// run on (released: the root's process died of `sig`,
	/// [`Self::release_foreground`]).
	fn end(&mut self, cx: &mut Cx<'_>, i: usize, sig: Signal, status: i32, externals: bool) {
		let vpid = self.procs[i].vpid;
		self.drop_take_in(vpid);
		let pipeline = runs_pipeline(&self.procs[i]);
		self.k.set_int_note(vpid, None);
		if self.procs[i].parent.is_some() {
			self.k.dies_of(vpid, sig);
		} else {
			self.k.died_of(vpid);
		}
		let p = &mut self.procs[i];
		for f in &mut p.frames {
			if let Some(sc) = f.scratch.as_mut() {
				match &mut sc.live {
					Live::Task(t) => t.signal(sig),
					Live::Ext(e) if externals => {
						let _ = e.signal(sig);
						let _ = e.cont();
					},
					_ => {},
				}
			}
		}
		exec::unwind(&mut self.k.root, cx.store, p, 0);
		while state::drop_scope(&mut self.k.root, cx.store, p) {}
		p.out.clear();
		p.blocked = None;
		p.stopped = false;
		p.status = status;
		let runs: Vec<Run> = p.runs.drain(..).collect();
		let vpid = (p.vpid, p.mode);
		for run in &runs {
			self.k.exec_signals.remove(&run.id);
			self.k.exec_refusals.remove(&run.id);
			if run.started {
				self
					.k
					.emit(cx, vpid, Some(run), EventData::RunEnd { status });
			}
			self.k.done.push_back((run.id, status));
		}
		// The root's process runs no program in place of the shell now.
		if self.procs[i].parent.is_none() {
			untrapped::program_ended(&mut self.k, cx, &self.procs[i]);
		}
		if self.procs[i].transient {
			let p = self.procs.remove(i);
			self.k.trace_sources.remove(&p.vpid);
			self.k.trace_unit_origins.remove(&p.vpid);
			self.k.settle_bang(p.vpid, None);
			self.k.forget_deferral(p.vpid);
			self.k.proc_exited(cx.store, p.vpid, p.parent, status);
			self.rr = 0;
			self.k.set_int_note(p.vpid, None);
			self.k.frozen_ints.retain(|v| *v != p.vpid);
			self.k.held_notices.retain(|(v, ..)| *v != p.vpid);
			let died = self.k.died_of(p.vpid);
			self.ended(p.vpid, p.parent);
			self.k.ctl.notify();
			self.reaped(cx, p.parent, p.vpid, status, died, pipeline);
		}
	}

	/// Add to `hits` (indices of signalled vprocs, left sorted) the labeled
	/// subshell trees that callouts of hit vprocs started
	/// ([`ShellApi::run_subshell_in`]), transitively: a signal to a callout's
	/// caller reaches its child tree, as one to a process reaches what it
	/// `exec`s or forwards to. Prunes the links of labels no vproc carries.
	fn callout_trees(&mut self, hits: &mut Vec<usize>) {
		let procs = &self.procs;
		let links = &mut self.k.callout_labels;
		links.retain(|&(label, _)| procs.iter().any(|p| p.lineage.label == label));
		let mut grew = !links.is_empty();
		while grew {
			grew = false;
			for &(label, caller) in links.iter() {
				if !hits.iter().any(|&i| procs[i].vpid == caller) {
					continue;
				}
				for (i, p) in procs.iter().enumerate() {
					if p.lineage.label == label && !hits.contains(&i) {
						hits.push(i);
						grew = true;
					}
				}
			}
		}
		hits.sort_unstable();
	}

	/// Whether `vpid` runs in a background job an earlier root script
	/// started ([`Kernel::prior_jobs`]): it leads one or descends from one.
	fn in_prior_job(&self, mut vpid: Vpid) -> bool {
		if self.k.prior_jobs.is_empty() {
			return false;
		}
		loop {
			if self.k.prior_jobs.contains(&vpid) {
				return true;
			}
			let Some(parent) = self
				.procs
				.iter()
				.find(|p| p.vpid == vpid)
				.and_then(|p| p.parent)
			else {
				return false;
			};
			vpid = parent;
		}
	}

	/// Whether `vpid` belongs to the job rooted at `root`, excluding nested
	/// jobs.
	fn in_job(&self, mut vpid: Vpid, root: Vpid) -> bool {
		loop {
			if vpid == root {
				return true;
			}
			let Some(parent) = self
				.procs
				.iter()
				.find(|p| p.vpid == vpid)
				.and_then(|p| p.parent)
			else {
				return false;
			};
			let Some(process) = self.procs.iter().find(|p| p.vpid == parent) else {
				return false;
			};
			if process.jobs.by_vpid(vpid).is_some() {
				return false;
			}
			vpid = parent;
		}
	}

	/// The running subshell of the `( … )` that vproc `i` only waits for
	/// before it exits (the job vproc of `( list ) &`; [`transparent`]'s
	/// `Some(false)` for a `( … )`), by index, when that `( … )` is the
	/// whole body of `i` ([`whole_stage`]): bash runs it in `i`'s process.
	fn paren_child(&self, i: usize) -> Option<usize> {
		let p = &self.procs[i];
		if transparent(p, true) != Some(false) {
			return None;
		}
		let [frame] = p.frames.as_slice() else {
			return None;
		};
		let unit = frame.unit.as_ref()?;
		let op = unit.ops.get(frame.pc as usize)?;
		if !matches!(unit.spawns.get(op.a as usize)?.kind, ir::SpawnKind::Subshell)
			|| !whole_stage(unit, frame.pc)
		{
			return None;
		}
		let [(child, None)] = frame.scratch.as_ref()?.children.as_slice() else {
			return None;
		};
		self.procs.iter().position(|q| q.vpid == *child)
	}

	/// What vproc `i` waits for, for bash's `INT` hold ([`HeldInt`]), when
	/// signal number `n` ([`control::Ctl::take_signals`]) reaches it: its
	/// foreground job (bash `wait_for` with `wait_sigint_handler`), when its
	/// innermost frame awaits an external or the stages or subshell of a
	/// `Spawn` still running (not one it runs itself, `lastpipe`); the output
	/// of a command substitution it reads while something still writes it
	/// (`command_substitute` blocks `SIGINT` around `read_comsub`, in every
	/// bash process), then the substitution's process, as a job
	/// (`wait_for`). `None`: it runs shell code, or did when the signal came,
	/// before its wait began ([`IntNote::WaitFrom`]).
	fn waits(&self, i: usize, n: u64) -> Option<HeldInt> {
		let p = &self.procs[i];
		if let Some(IntNote::WaitFrom(from)) = self.k.int_note(p.vpid)
			&& n <= from
		{
			return None;
		}
		let sc = p.frames.last()?.scratch.as_ref()?;
		let external = matches!(sc.live, Live::Ext(_))
			&& sc
				.exec
				.as_ref()
				.is_some_and(|e| matches!(e.waiting, Some(proc::Awaited::Ext { .. })));
		let stages = sc.inline().is_none() && sc.children.iter().any(|(_, status)| status.is_none());
		if external || stages {
			return Some(HeldInt::Job { caught: false });
		}
		match &sc.sub {
			Some(proc::PendingSub::Fork { capture, .. }) if capture.has_writers() => {
				Some(HeldInt::Comsub)
			},
			Some(proc::PendingSub::Fork { .. }) => Some(HeldInt::Job { caught: false }),
			_ => None,
		}
	}

	/// A vproc that holds an `INT` while it reads a substitution's output
	/// ([`HeldInt::Comsub`]), whose output nothing writes any more (its
	/// process closed or moved its standard output, and no program of it
	/// holds a copy): the read is over, and it acts on the `INT` now, as
	/// bash does once `read_comsub` reads end of file and `SIGINT` is
	/// unblocked, before it waits for the substitution's process; that wait
	/// begins after the signal ([`IntNote::WaitFrom`]), and holds a later
	/// one as for a job ([`Self::waits`]).
	fn comsub_reads_ended(&mut self) {
		let ended: Vec<Vpid> = self
			.k
			.int_notes
			.iter()
			.filter(|&&(_, note)| note == IntNote::Held(HeldInt::Comsub))
			.map(|&(vpid, _)| vpid)
			.filter(|&vpid| {
				self
					.procs
					.iter()
					.find(|p| p.vpid == vpid)
					.and_then(|p| p.frames.last()?.scratch.as_ref())
					.is_some_and(|sc| {
						matches!(&sc.sub, Some(proc::PendingSub::Fork { capture, .. }) if !capture.has_writers())
					})
			})
			.collect();
		for vpid in ended {
			ControlHandle(Arc::clone(&self.k.ctl)).signal(SigTarget::Vpid(vpid), Signal::Int);
			let from = self.k.ctl.signals_queued();
			self.k.set_int_note(vpid, Some(IntNote::WaitFrom(from)));
		}
	}

	/// The vprocs of the root's foreground command, parents first: each
	/// child of the root (a stage, a subshell, a command or process
	/// substitution), then each of theirs, and so on, but a job of its own
	/// (in its parent's job table). `shell_group`: only those bash runs in
	/// the shell's own process group under job control (`set -m`): not the
	/// stages or subshell of the foreground job the root waits for, which
	/// bash runs in a group of their own, nor theirs.
	fn foreground_tree(&self, shell_group: bool) -> Vec<Vpid> {
		let root = &self.procs[0];
		let job: Vec<Vpid> = if shell_group {
			root
				.frames
				.iter()
				.filter_map(|f| f.scratch.as_ref())
				.flat_map(|sc| sc.children.iter().map(|&(vpid, _)| vpid))
				.collect()
		} else {
			Vec::new()
		};
		let mut tree = vec![root.vpid];
		let mut next = 0;
		while let Some(&parent) = tree.get(next) {
			next += 1;
			let Some(owner) = self.procs.iter().find(|p| p.vpid == parent) else {
				continue;
			};
			for p in &self.procs {
				if p.parent == Some(parent)
					&& owner.jobs.by_vpid(p.vpid).is_none()
					&& !tree.contains(&p.vpid)
					&& !job.contains(&p.vpid)
				{
					tree.push(p.vpid);
				}
			}
		}
		tree.remove(0);
		tree
	}

	/// Let the externals of the root's foreground command outlive the shell
	/// ([`exec::release_externals`]): the root's own and those of each vproc
	/// of [`Self::foreground_tree`]. bash's `termsig_handler` and zsh's
	/// `zexit` end the shell's process alone, and so does a signal's default
	/// action: the processes of its foreground command go on. Shell code of
	/// a stage or a subshell runs in obash's process, and ends with it.
	fn release_foreground(&mut self) {
		let tree = self.foreground_tree(false);
		for p in self
			.procs
			.iter_mut()
			.filter(|p| p.parent.is_none() || tree.contains(&p.vpid))
		{
			exec::release_externals(p);
		}
	}

	/// The vprocs of the root's foreground command that get the `INT` of
	/// the shell's process group ([`Self::int_to_foreground`]), parents
	/// first: each bash process of the command bash runs in the shell's
	/// group. Without job control that is each stage, subshell and
	/// substitution, where obash runs their code in its own process, which
	/// gets the signal once; under `set -m` the stages and subshell of a
	/// foreground job are in a group of their own, and get none, while its
	/// substitutions are in the shell's ([`Self::foreground_tree`]). Not
	/// those made when a wait began after the signal came: the kernel's
	/// signal did not reach the processes bash forks after it. Taken before
	/// the root takes the signal, whose end (its EXIT trap, or its death)
	/// unwinds the frames that name its foreground job. `None` after a store
	/// failure.
	fn int_targets(&mut self, cx: &mut Cx<'_>, n: u64) -> Option<Vec<Vpid>> {
		let monitor = match state::option(&mut self.k.root, cx.store, &self.procs[0], OptId::Monitor)
		{
			Ok(monitor) => monitor,
			Err(err) => {
				self.k.fail(err);
				return None;
			},
		};
		let mut later: Vec<Vpid> = Vec::new();
		let mut targets = Vec::new();
		for vpid in self.foreground_tree(monitor) {
			let Some(p) = self.procs.iter().find(|p| p.vpid == vpid) else {
				continue;
			};
			if let Some(parent) = p.parent
				&& (later.contains(&parent)
					|| matches!(self.k.int_note(parent), Some(IntNote::WaitFrom(from)) if n <= from))
			{
				later.push(vpid);
				continue;
			}
			targets.push(vpid);
		}
		Some(targets)
	}

	/// The `INT` of the shell's process group, as each bash process of the
	/// root's foreground command gets it: `targets`, from
	/// [`Self::int_targets`]. Parents first, so that each one's end reaches
	/// its parent's hold ([`Self::reaped`]). One that is just its program
	/// ([`transparent`]) leaves the signal to the program, which has it from
	/// the kernel; one with an `INT` trap of its own runs it, or ignores it
	/// (`trap ''`, a background job's); else it holds it while it waits for a
	/// job of its own or reads a substitution ([`HeldInt`]), and dies of it
	/// (after an EXIT trap of its own) while it runs shell code, as a bash
	/// subshell does ([`Self::take`], as [`Self::deliver`] gives a signal).
	///
	/// An `INT` from another process ([`SigTarget::Outside`]) is taken as the
	/// group's, though a `kill` of the shell's pid alone sends one too: taken
	/// as the shell's alone, a `kill` of the group (`timeout`, a runner's
	/// cancel) would leave a stage of shell code running on, a loop forever
	/// (`while :; do sleep 1; done | cmd`), where bash's stage dies. So
	/// without job control a `kill -INT` of obash's pid alone also ends the
	/// shell code of its foreground command, which bash's subshells would
	/// run on: a known difference.
	fn int_to_foreground(&mut self, cx: &mut Cx<'_>, n: u64, targets: Vec<Vpid>) {
		let key = crate::bash::store::TrapKey::Signal(Signal::Int);
		for vpid in targets {
			let Some(i) = self.procs.iter().position(|p| p.vpid == vpid) else {
				continue;
			};
			let p = &self.procs[i];
			if p.mode.dialect() != crate::bash::ids::Dialect::Bash
				|| transparent(p, false) == Some(true)
			{
				continue;
			}
			// An ignoring trap stays in a subshell; one with an action only
			// where the subshell set it.
			let trap = match state::record(cx.store, p, crate::bash::store::Key::Trap(key)) {
				Ok(Some(Record::Trap { action, .. })) if action.is_empty() => Some(true),
				Ok(Some(Record::Trap { .. })) if p.own_traps.has(key) => Some(false),
				Ok(_) => match exec::async_ignored(cx.store, p, Signal::Int, false) {
					Ok(ignored) => ignored.then_some(true),
					Err(err) => {
						self.k.fail(err);
						return;
					},
				},
				Err(err) => {
					self.k.fail(err);
					return;
				},
			};
			if let Err(err) = self.take(cx, i, i, Signal::Int, n, trap, false) {
				self.k.fail(err);
				return;
			}
		}
	}

	/// Vproc `i` takes signal number `n`, `sig`. With a trap (`trap`:
	/// `Some(true)` an ignoring one), the trap of vproc `own` (`i`, or the
	/// zsh `( … )` the root runs in place of itself, [`Self::in_place_end`])
	/// is due ([`trapped`]); without one, what the shell does itself
	/// ([`untrapped::decide`]). `pass_on`: the signal was sent to more than
	/// the shell's own process, so what `i` runs gets it too. One step for
	/// [`Self::deliver`] and [`Self::int_to_foreground`]: the job change of
	/// a stop or continue, if any.
	///
	/// # Errors
	///
	/// A store failure reading the held set, an option or the EXIT trap.
	#[expect(clippy::too_many_arguments, reason = "the signal, its trap and its reach, one step")]
	fn take(
		&mut self,
		cx: &mut Cx<'_>,
		i: usize,
		own: usize,
		sig: Signal,
		n: u64,
		trap: Option<bool>,
		pass_on: bool,
	) -> Result<Option<(Vpid, Option<Signal>)>, StoreError> {
		let platform = self.k.engine.config().platform;
		if let Some(ignored) = trap {
			if !ignored {
				trapped(&mut self.k, &mut self.procs[own], sig, platform);
			}
			return Ok(None);
		}
		// Without job control bash holds an `INT` while it waits for a job,
		// and while it reads a command substitution ([`Self::waits`]).
		let waits = self.waits(i, n);
		let decision = untrapped::decide(&mut self.k, cx, &mut self.procs[i], sig, waits)?;
		let status = sig.exit_status(platform);
		let root = self.procs[i].parent.is_none();
		let vpid = self.procs[i].vpid;
		match decision {
			untrapped::Untrapped::Handled | untrapped::Untrapped::Ignored => {},
			untrapped::Untrapped::ZshHupExit => {
				if pass_on {
					signal_lives(&mut self.procs[i], sig, false);
				}
				if root {
					self.release_foreground();
				}
				exec::zsh_hup_exit(&mut self.k, &mut self.procs[i], cx);
			},
			untrapped::Untrapped::Held(held) => {
				if pass_on {
					signal_lives(&mut self.procs[i], sig, false);
				}
				// The wait's end decides ([`end_held_sigint`]).
				self.k.set_int_note(vpid, Some(IntNote::Held(held)));
			},
			// bash `termsig_sighandler`: a terminating signal that comes while
			// the EXIT trap a first one began runs ends the shell at once, by
			// itself; obash had begun the trap again, and again.
			untrapped::Untrapped::BashExitTrapThenDie if exec::terminating(&self.procs[i]) => {
				if root {
					self.k.killed_by = Some(i32::from(sig.number(platform)));
					self.release_foreground();
					self.end(cx, i, sig, status, false);
				} else {
					self.kill(cx, i, sig, status);
				}
			},
			untrapped::Untrapped::BashExitTrapThenDie => {
				if pass_on {
					signal_lives(&mut self.procs[i], sig, true);
				}
				if root {
					self.k.killed_by = Some(i32::from(sig.number(platform)));
					self.release_foreground();
				} else {
					// bash's subshell kills itself with the signal once the trap
					// has run: its parent's reap reads a death by it, not by an
					// `INT` that began its end.
					self.k.dies_of(vpid, sig);
				}
				exec::bash_termsig(&mut self.k, &mut self.procs[i], cx, status);
			},
			untrapped::Untrapped::Default => match sig.default_action() {
				DefaultAction::Terminate if root => {
					// The root shell dies of the signal: a process host dies of it
					// too ([`Shell::killed_by`]), and leaves its foreground command
					// running, its own program too, as the kernel's signal to a
					// real shell does.
					self.k.killed_by = Some(i32::from(sig.number(platform)));
					self.release_foreground();
					self.end(cx, i, sig, status, false);
				},
				DefaultAction::Terminate => self.kill(cx, i, sig, status),
				DefaultAction::Stop | DefaultAction::Continue => {
					let stop = sig.default_action() == DefaultAction::Stop;
					let p = &mut self.procs[i];
					let change = (p.stopped != stop).then_some((p.vpid, stop.then_some(sig)));
					set_stopped(p, stop);
					return Ok(change);
				},
				DefaultAction::Ignore => {},
			},
		}
		Ok(None)
	}

	/// The vproc at the end of the chain that the process of vproc `i` is:
	/// `i`, or the zsh `( … )` it runs in place of itself
	/// ([`proc::VprocZsh::in_place`]), and so on down.
	fn in_place_end(&self, mut i: usize) -> usize {
		while let Some(j) = self
			.procs
			.iter()
			.position(|q| q.parent == Some(self.procs[i].vpid) && q.in_place())
		{
			i = j;
		}
		i
	}

	/// Deliver virtual signal number `n` ([`control::Ctl::take_signals`]) to
	/// its target or its configured trap.
	fn deliver(&mut self, cx: &mut Cx<'_>, target: SigTarget, sig: Signal, n: u64) {
		let root = (self.procs[0].vpid, self.procs[0].mode);
		self
			.k
			.emit(cx, root, None, EventData::Signal { sig, target });
		let platform = self.k.engine.config().platform;
		let (target, sender) = match target {
			SigTarget::Group(v) => (SigTarget::Vpid(v), Sender::Kernel),
			SigTarget::Outside(v) => (SigTarget::Vpid(v), Sender::Process),
			target => (target, Sender::Shell),
		};
		// A foreground job's processes are the shell's own children, with no
		// vproc of the job's: bash's `kill_pid` signals each one still alive
		// ([`proc::Job::foreground`]).
		let job_roots: Vec<Vpid> = match target {
			SigTarget::Job(id) => self
				.procs
				.iter()
				.flat_map(|p| p.jobs.iter())
				.find(|job| job.id == id)
				.map_or_else(Vec::new, |job| match job.procs.as_deref() {
					Some(procs) if job.foreground => procs
						.list
						.iter()
						.filter(|p| p.state == proc::ProcState::Running)
						.map(|p| p.vpid)
						.collect(),
					_ => vec![job.vpid],
				}),
			_ => Vec::new(),
		};
		let mut hits: Vec<usize> = (0..self.procs.len())
			.filter(|&i| match target {
				SigTarget::Vpid(v) | SigTarget::Group(v) | SigTarget::Outside(v) => {
					self.procs[i].vpid == v
				},
				SigTarget::All => true,
				SigTarget::Job(_) => job_roots
					.iter()
					.any(|&v| self.in_job(self.procs[i].vpid, v)),
				SigTarget::Label(l) => l != 0 && self.procs[i].lineage.label == l,
				SigTarget::Tree(v) => self.in_job(self.procs[i].vpid, v),
			})
			.collect();
		// bash forks once for `( list ) &` (and `( list ) >file &`), and that
		// one process is the subshell: a signal sent to the pid of a vproc
		// that only waits for its `( … )` (the job vproc of `( list ) &`,
		// `$!`) reaches that subshell, as `kill %1` does, and through it the
		// `( … )` that is a subshell's whole body (`( ( … ) )`), which bash
		// runs in the same process, but not one after another command
		// (`( :; ( … ) )`), for which bash forks again. Each such waiter is
		// transparent to the signal below, so it ends with its subshell's
		// status.
		let mut waiters: Vec<Vpid> = Vec::new();
		if let SigTarget::Vpid(v) = target {
			let mut at = hits.iter().copied().find(|&i| self.procs[i].vpid == v);
			while let Some(child) = at.and_then(|i| self.paren_child(i)) {
				if let Some(i) = at {
					waiters.push(self.procs[i].vpid);
				}
				if !hits.contains(&child) {
					hits.push(child);
				}
				at = Some(child);
			}
		}
		// The kernel's `INT` reaches every process of the group: each bash
		// process of the foreground command has it too. One from another
		// process may be the group's or the shell's alone, which a signal does
		// not tell apart: it is taken as the group's
		// ([`Self::int_to_foreground`]). Who gets it is fixed before the root
		// takes it ([`Self::int_targets`]).
		let foreground = if sender != Sender::Shell
			&& sig == Signal::Int
			&& target == SigTarget::Vpid(root.0)
			&& root.1.dialect() == crate::bash::ids::Dialect::Bash
		{
			match self.int_targets(cx, n) {
				Some(targets) => Some(targets),
				None => return,
			}
		} else {
			None
		};
		self.callout_trees(&mut hits);
		// Vprocs this signal stopped or continued (job states follow).
		let mut changed: Vec<(Vpid, Option<Signal>)> = Vec::new();
		for &i in hits.iter().rev() {
			// A signal to the shell is the process's: its trap is the one of
			// the zsh `( … )` the root runs in place of itself, if it does
			// ([`Self::in_place_end`]), which runs it.
			let own = if target == SigTarget::Vpid(root.0) && sig != Signal::Chld {
				self.in_place_end(i)
			} else {
				i
			};
			let trap = if matches!(sig, Signal::Kill | Signal::Stop) {
				None
			} else {
				let key = crate::bash::store::TrapKey::Signal(sig);
				let p = &self.procs[own];
				let recorded = match state::record(cx.store, p, crate::bash::store::Key::Trap(key)) {
					Ok(Some(Record::Trap { action, .. })) => Ok(Some(action.is_empty())),
					Ok(_) => Ok(None),
					Err(err) => Err(err),
				};
				// zsh: a `TRAPNAL` function is the trap (`ZSIG_FUNC`).
				let found = recorded.and_then(|trap| match trap {
					None if p.mode.dialect() == crate::bash::ids::Dialect::Zsh => {
						builtins::trap::find_func_trap(cx.store, p, key, platform, |_, _| false)
					},
					trap => Ok(trap),
				});
				// bash: an asynchronous command ignores `INT` and `QUIT` sent
				// to it while it has no trap for them ([`exec::async_ignored`]).
				let found = found.and_then(|trap| match trap {
					None if matches!(sig, Signal::Int | Signal::Quit) => {
						exec::async_ignored(cx.store, p, sig, false)
							.map(|ignored| ignored.then_some(true))
					},
					trap => Ok(trap),
				});
				match found {
					Ok(trap) => trap,
					Err(err) => {
						self.k.fail(err);
						return;
					},
				}
			};
			// The program the root runs in place of the shell (`exec`, or a
			// command the real shell runs without a fork, in the root or in a
			// zsh `( … )` it runs in place) is the real shell's process: a
			// signal sent to the shell is the program's (one the shell ignores
			// the program inherits ignored), and the shell ends as the program
			// does. `CHLD` comes from the engine's children.
			if target == SigTarget::Vpid(root.0)
				&& sig != Signal::Chld
				&& trap != Some(true)
				&& forward_to_program(&mut self.k, &mut self.procs[own], sig, sender != Sender::Kernel)
			{
				continue;
			}
			let terminating = trap.is_none() && sig.default_action() == DefaultAction::Terminate;
			// A signal to the shell PID does not also target its foreground child.
			// A terminating child is signaled once by `kill`, not here and there.
			if target != SigTarget::Vpid(root.0) && !terminating {
				signal_lives(&mut self.procs[i], sig, false);
			}
			// A vproc that is just its program (bash would have `exec`'d it:
			// `cmd &`, a pipeline stage, `( cmd )`, `exec cmd`) or just waits
			// for children the signal reaches too (the job vproc of `a | b &`)
			// does not die by itself: the program gets the signal and may trap
			// it, and the vproc ends with the program's real status, once it
			// has exited (`wait` returns then, not before).
			if terminating && target != SigTarget::Vpid(root.0) {
				let reaches_children =
					!matches!(target, SigTarget::Vpid(_)) || waiters.contains(&self.procs[i].vpid);
				if let Some(lone) = transparent(&self.procs[i], reaches_children) {
					let p = &mut self.procs[i];
					let stopped = p.stopped;
					if lone {
						for frame in &mut p.frames {
							if let Some(Live::Ext(ext)) = frame.scratch.as_mut().map(|sc| &mut sc.live) {
								let _ = ext.signal(sig);
							}
						}
					}
					if stopped {
						// Continued so the program can act on the signal (bash
						// `kill_pid` continues a stopped job it signals).
						set_stopped(p, false);
						changed.push((p.vpid, None));
					}
					continue;
				}
			}
			// The line editor of the interactive shell: `SIGINT` abandons the
			// line being read, `SIGWINCH` makes it redisplay.
			if self.procs[i].parent.is_none() && zle::signal(&mut self.procs[i], sig, trap.is_some()) {
				continue;
			}
			// A signal sent to more than the shell reaches what it runs too;
			// the shell does not wait for that to end.
			match self.take(cx, i, own, sig, n, trap, target != SigTarget::Vpid(root.0)) {
				Ok(Some(change)) => changed.push(change),
				Ok(None) => {},
				Err(err) => {
					self.k.fail(err);
					return;
				},
			}
		}
		if let Some(targets) = foreground {
			self.int_to_foreground(cx, n, targets);
		}
		for (vpid, stop) in changed {
			self.job_changed(cx, vpid, stop);
		}
	}

	fn set_paused(&mut self, cx: &mut Cx<'_>, on: bool) {
		self.k.paused = on;
		for p in &mut self.procs {
			pause_handles(p, on);
		}
		let root = (self.procs[0].vpid, self.procs[0].mode);
		let data = if on {
			EventData::Stopped { job: None }
		} else {
			EventData::Continued { job: None }
		};
		self.k.emit(cx, root, None, data);
	}

	/// Abandon every script after a store failure.
	fn fail_all(&mut self, cx: &mut Cx<'_>, err: &StoreError) {
		let root = (self.procs[0].vpid, self.procs[0].mode);
		let message = BString::from(format!("{}: {err}", Diag::StoreFailed));
		self.k.emit(cx, root, None, EventData::Diag {
			code:    Diag::StoreFailed.code(),
			message: BStr::new(&message),
		});
		for i in (0..self.procs.len()).rev() {
			self.kill(cx, i, Signal::Term, 1);
		}
	}

	/// `vpid`'s command ended early (a cancel, a kill, a store failure): a
	/// builtin of it parked on its take-in will not run again to use the
	/// answer, so its ask and its answer go. Kept, either would hold every
	/// later signal trap of the vproc for good ([`Kernel::asking`]).
	fn drop_take_in(&mut self, vpid: Vpid) {
		self.k.exits_asked.retain(|&v| v != vpid);
		self.k.exits_taken.retain(|&v| v != vpid);
		self.taking_in.retain(|t| t.asker != vpid);
	}

	/// Whether a vproc carrying lineage label `label` still exists (running,
	/// or submitted and not adopted yet): the label's tree has not ended.
	pub fn label_live(&self, label: u32) -> bool {
		label != 0
			&& self
				.procs
				.iter()
				.chain(&self.k.spawned)
				.any(|p| p.lineage.label == label)
	}

	/// Whether root run `run` (a [`VprocSel::Root`] script) ended through
	/// `exit` or `set -e` rather than by reaching its end: a host that runs
	/// one command as several root scripts stops after such a one, as bash
	/// would have left the command there. Known for the last such run only;
	/// ask right after its [`Step::Done`].
	pub fn ended_by_exit(&self, run: RunId) -> bool {
		self.k.exited == Some(run)
	}

	/// The signal that killed an external replacing `run`, if any. Ask
	/// immediately after its [`Step::Done`]; ordinary `exit 128+n` is not
	/// a signal death.
	pub fn exec_signal(&self, run: RunId) -> Option<i32> {
		self
			.k
			.reported_signal
			.filter(|(id, _)| *id == run)
			.map(|(_, signal)| signal)
	}

	/// The `exec` the system refused, replacing `run`, if `run` was
	/// submitted with [`Script::too_long_to_host`] (a line too long) or
	/// [`Script::refusals_to_host`] (any refusal). Ask immediately after its
	/// [`Step::Done`].
	pub fn exec_refusal(&self, run: RunId) -> Option<ExecRefusal> {
		self
			.k
			.reported_refusal
			.filter(|(id, _)| *id == run)
			.map(|(_, refusal)| refusal)
	}

	/// The signal the root shell took the default action of (`kill -TERM
	/// $$` without a trap), ending its scripts: a process host dies of it
	/// too, as zsh and bash do, so that its parent sees `WIFSIGNALED`.
	/// Ordinary `exit 128+n` is not a signal death.
	pub const fn killed_by(&self) -> Option<i32> {
		self.k.killed_by
	}

	/// Number of the root's background jobs that still wait for a running
	/// external process, or for the host to finish starting one (`sh -c
	/// 'sleep 9' &`, a pipeline stage); jobs that
	/// only run in-engine work (a builtin `sleep`, a loop) are not counted.
	/// A host keeping a shell alive for its externals asks this between
	/// scripts.
	pub fn live_external_jobs(&self) -> usize {
		let Some(root) = self.procs.first() else {
			return 0;
		};
		root
			.jobs
			.iter()
			.filter(|job| {
				self.procs.iter().any(|p| {
					self.in_job(p.vpid, job.vpid)
						&& p.frames.iter().any(|f| {
							f.scratch
								.as_ref()
								.is_some_and(|sc| matches!(sc.live, Live::Ext(_) | Live::Spawn(_)))
						})
				})
			})
			.count()
	}

	/// Answer a [`Step::Call`]. Unknown ids (cancelled scripts) are ignored.
	pub fn complete(&mut self, call: CallId, outcome: CallOutcome) {
		if self.awaiting(call).is_some() {
			self.k.results.insert(call, outcome);
			self.k.ctl.notify();
		}
	}

	/// Index of the vproc whose `Exec` awaits `call`.
	fn awaiting(&self, call: CallId) -> Option<usize> {
		self.procs.iter().position(|p| {
			p.frames.iter().any(|f| {
				f.scratch
					.as_ref()
					.and_then(|s| s.exec.as_ref())
					.is_some_and(|e| e.waiting == Some(proc::Awaited::Call(call)))
			})
		})
	}

	/// The engine waker. Hosts poll every [`Task`](crate::bash::Task),
	/// [`ExtProc`](crate::bash::ExtProc), [`FsPending`](crate::bash::FsPending)
	/// and [`File`] they hand the engine with a `Context` built from it; the
	/// engine already does so itself. Waking it makes
	/// [`ControlHandle::poll_runnable`] ready.
	pub fn wake(&self) -> Waker {
		self.k.waker.clone()
	}

	/// Thread-safe control handle.
	pub fn control(&self) -> ControlHandle {
		ControlHandle(Arc::clone(&self.k.ctl))
	}

	/// Select the emitted event kinds for a new observer generation.
	/// Units are announced again only when parsed or executed, even when
	/// the mask is unchanged; cached functions are never read ahead.
	pub fn set_event_mask(&mut self, mask: EventMask) {
		self.k.mask = mask;
		self.k.announced.clear();
	}

	/// The current event mask.
	pub const fn event_mask(&self) -> EventMask {
		self.k.mask
	}
}

/// Define a function exported through the environment (`BASH_FUNC_f%%`).
fn import_function(k: &mut Kernel, store: &mut dyn StateStore, name: &[u8], value: &[u8]) {
	if let Some(rec) = imported_function(k, name, value) {
		if let Record::Func { unit, .. } = &rec
			&& let Some(unit) = k.engine.cached(unit)
		{
			k.persist_unit(store, &unit);
		}
		k.root
			.set_record(store, KeyBuf::Func(BString::from(name)), Some(rec));
	}
}

/// The function a `BASH_FUNC_name%%` environment entry defines (`None` when
/// the text is not exactly that function), for a new shell's state
/// ([`Shell::create`], the in-engine nested shell).
pub fn imported_function(k: &Kernel, name: &[u8], value: &[u8]) -> Option<Record> {
	if !value.starts_with(b"() {") {
		return None;
	}
	let mut src = Vec::with_capacity(name.len() + value.len() + 1);
	src.extend_from_slice(name);
	src.push(b' ');
	src.extend_from_slice(value);
	// bash `SEVAL_FUNCDEF`: the text must define exactly the function named.
	// Exported functions are bash text, whatever the shell's mode.
	let func = ir::function_from_source(&src, ModeId::Bash, crate::bash::syntax::Features::NONE)
		.filter(|f| f.name.as_slice() == name)?;
	let source = ir::FuncText::of(&func);
	let unit = k.engine.intern(Arc::unwrap_or_clone(func.body));
	Some(Record::Func {
		mode: ModeId::Bash,
		sticky: None,
		source,
		unit: unit.id,
		attrs: Attrs::EXPORT,
		// bash's `make_function_def` before the shell is initialized.
		file: BString::from("environment"),
	})
}

/// A child of `p` finished: if `p` traps `SIGCHLD`, it owes one more run of
/// the trap (bash's `waitchld` counts the children it reaped and runs the
/// trap that many times). Called by the scheduler for child vprocs, for each
/// process of one of `p`'s pipeline jobs as the job's vproc reaps it
/// ([`Shell::reaped`]), and by `Exec` for externals `p` ran itself; `job`:
/// the child was this one of `p`'s background jobs. zsh (`update_job`) runs
/// the trap (a `trap` action or the `TRAPCHLD` function) only for those, not
/// for the foreground job, one run per job ([`proc::VprocZsh::chld_jobs`]).
/// A child reaped while the `CHLD` trap runs owes none: bash queues the trap
/// and then drops it (`run_pending_traps` finds the trap's slot busy and
/// warns `bad value in trap_list[17]`), and zsh 5.9 runs it once too, even
/// for a job the trap's `wait` waited for, or one of its own children (a
/// `$( )`, a program).
pub fn owe_chld(k: &mut Kernel, cx: &mut Cx<'_>, p: &mut Vproc, job: Option<Vpid>) {
	let zsh = p.mode.dialect() == crate::bash::ids::Dialect::Zsh;
	if zsh && job.is_none() {
		return;
	}
	let chld = crate::bash::store::TrapKey::Signal(Signal::Chld);
	if p.trap_frames != 0
		&& p.frames.iter().any(|f| {
			matches!(f.kind, FrameKind::Script { what: ScriptKind::Trap { key, .. }, .. } if key == chld)
		})
	{
		return;
	}
	let key = crate::bash::store::Key::Trap(crate::bash::store::TrapKey::Signal(Signal::Chld));
	let trapped = match state::record(cx.store, p, key) {
		Ok(Some(Record::Trap { action, .. })) => !action.is_empty(),
		Ok(None) if zsh => matches!(
			state::record(cx.store, p, crate::bash::store::Key::Func(bstr::BStr::new(b"TRAPCHLD"))),
			Ok(Some(Record::Func { .. }))
		),
		Ok(_) => false,
		Err(err) => {
			k.fail(err);
			false
		},
	};
	if trapped {
		p.jobs.chld += 1;
		p.pending_traps = p.pending_traps.with(Signal::Chld);
		if let (true, Some(job)) = (zsh, job) {
			p.zsh_state().chld_jobs.push_back(job);
		}
		if !p.waiting_foreground() {
			p.blocked = None;
		}
		// bash in posix mode queues the trap and ends a `wait` it is in,
		// with 128 + `SIGCHLD` (`jobs.c:4240-4250`); the trap runs after.
		if !zsh && state::option(&mut k.root, cx.store, p, OptId::Posix).unwrap_or(false) {
			interrupt_wait(p, Signal::Chld.exit_status(k.engine.config().platform));
		}
	}
}

/// End a `wait` builtin that `p` is in with `status` (a trapped signal
/// arrived): its `Exec` completes at once, keeping the jobs it waited for.
fn interrupt_wait(p: &mut Vproc, status: i32) {
	for frame in &mut p.frames {
		let Some(e) = frame.scratch.as_mut().and_then(|sc| sc.exec.as_mut()) else {
			continue;
		};
		let waiting = matches!(
			e.waiting,
			Some(proc::Awaited::Jobs { .. } | proc::Awaited::AllJobs | proc::Awaited::AnyJob { .. })
		);
		if waiting && e.target == Some(proc::Target::Intrinsic(crate::bash::ids::IntrinsicId::Wait)) {
			e.waiting = Some(proc::Awaited::Jobs { force: true });
			e.wait_for.clear();
			e.wait_into = None;
			e.status = status;
		}
	}
}

/// A signal reaches vproc `p`, whose trap for it has an action (bash
/// `trap_handler`): the trap is due, at once unless `p` waits for its
/// foreground command (bash runs it once the command has ended), and a
/// `wait` builtin `p` is in ends with 128 + the signal's number (then the
/// trap runs); `SIGCHLD` ends none.
fn trapped(k: &mut Kernel, p: &mut Vproc, sig: Signal, platform: crate::bash::ids::Platform) {
	p.pending_traps = p.pending_traps.with(sig);
	// bash's `wait_for` runs the `INT` trap itself, the job list frozen,
	// once the forked foreground command it waits for has ended.
	if sig == Signal::Int && p.waiting_for_a_fork() && !k.frozen_ints.contains(&p.vpid) {
		k.frozen_ints.push(p.vpid);
	}
	if !p.waiting_foreground() {
		p.blocked = None;
	}
	if sig != Signal::Chld {
		interrupt_wait(p, sig.exit_status(platform));
	}
}

/// Who sent a signal `Shell::deliver` gives.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Sender {
	/// The shell: `kill`, a job's or the engine's own signal.
	Shell,
	/// The kernel, to the root's OS process group ([`SigTarget::Group`]): a
	/// terminal's `INT`, `QUIT` or hangup `HUP`. A program the root runs in
	/// place of itself, in that group too, has it already.
	Kernel,
	/// Another process ([`SigTarget::Outside`], `SI_USER`): to the shell's
	/// pid alone or to its process group, which the signal does not tell
	/// apart.
	Process,
}

/// bash's `INT` as a vproc has it ([`Kernel::int_notes`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntNote {
	/// Noted while it waits ([`HeldInt`]), to act on once the wait ends
	/// ([`end_held_sigint`]).
	Held(HeldInt),
	/// Its wait began ([`wait_starts`]) once the signals up to this number
	/// were queued ([`control::Ctl::signals_queued`]): one of them came while
	/// it ran shell code ([`Shell::waits`]), and did not reach the vprocs
	/// it made then.
	WaitFrom(u64),
}

/// An `INT` a bash vproc noted ([`IntNote::Held`]), and what it does once
/// what it waits for has ended ([`end_held_sigint`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeldInt {
	/// While it waited, without job control, for its foreground job (bash
	/// `wait_for`'s `wait_sigint_handler`): it acts only if the last process
	/// of the job to end died of `SIGINT`; `caught`: that process ended
	/// otherwise (bash `child_caught_sigint`, which `waitchld` sets again for
	/// each child it reaps: [`external_ended`], [`Shell::reaped`]).
	Job { caught: bool },
	/// While it read a command substitution's output, with or without an
	/// EXIT trap and job control (bash blocks `SIGINT` around
	/// `read_comsub`): once the read ends (nothing writes the output any
	/// more, [`Shell::comsub_reads_ended`], or the substitution's process
	/// ended) it acts whatever the substitution's processes did.
	Comsub,
}

/// The external `vp` ran ended (`killed`: by that signal): the last
/// process of the job `vp` holds an `INT` for ended so ([`HeldInt::Job`]).
/// Where `vp` is that program (`replacing`: it `exec`ed it; or it is just
/// that program, [`transparent`]), the program's end is `vp`'s: a death by
/// a signal is `vp`'s ([`Kernel::deaths`]), and an exit clears one a
/// signal began (an EXIT trap that `exec`s a program). Then `vp`'s wait
/// for it is over ([`end_held_sigint`]).
fn external_ended(k: &mut Kernel, vp: &Vproc, killed: Option<Signal>, replacing: bool) {
	if let Some(IntNote::Held(HeldInt::Job { .. })) = k.int_note(vp.vpid) {
		let caught = killed != Some(Signal::Int);
		k.set_int_note(vp.vpid, Some(IntNote::Held(HeldInt::Job { caught })));
	}
	if vp.parent.is_some() && (replacing || transparent(vp, false) == Some(true)) {
		match killed {
			Some(sig) => k.dies_of(vp.vpid, sig),
			None => {
				k.died_of(vp.vpid);
			},
		}
	}
	end_held_sigint(k, vp, false);
}

/// `vp`'s wait for what it held an `INT` for is over: its foreground job,
/// or (`comsub`) the command substitution it read. It acts on the
/// `INT` now, as on one that comes while it waits for nothing
/// ([`untrapped::decide`]), unless the last process of the job caught it;
/// then it goes on.
fn end_held_sigint(k: &mut Kernel, vp: &Vproc, comsub: bool) {
	let act = match k.int_note(vp.vpid) {
		Some(IntNote::Held(HeldInt::Job { caught })) if !comsub => !caught,
		Some(IntNote::Held(HeldInt::Comsub)) if comsub => true,
		_ => return,
	};
	k.set_int_note(vp.vpid, None);
	if act {
		ControlHandle(Arc::clone(&k.ctl)).signal(SigTarget::Vpid(vp.vpid), Signal::Int);
	}
}

/// `vp` begins to wait for what it runs: an external, the stages or
/// subshell of a `Spawn`, a command substitution (bash `wait_for`, which
/// clears `wait_sigint_received` and only then installs
/// `wait_sigint_handler`). A signal that came before reached a process
/// running shell code, and none that bash forked after it: the host hands
/// over each signal its handler has seen by now (on the engine's thread,
/// which the kernel gives a signal to the process first), and the vproc
/// takes those as come before its wait ([`IntNote::WaitFrom`]). A later
/// one finds it waiting.
fn wait_starts(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) {
	cx.host.forward_signals();
	let from = k.ctl.signals_queued();
	k.set_int_note(vp.vpid, Some(IntNote::WaitFrom(from)));
}

/// Give `sig` to the external `p`'s innermost frame runs in place of the
/// shell: one it `exec`s, or one the real shell runs without a fork
/// ([`runs_in_place`]). The real shell's process is then the program, so a
/// signal sent to the shell is the program's: given at once, or once the
/// program's spawn has finished ([`Kernel::forward`]). One the kernel sent
/// the whole process group (`give` false) the running program has already;
/// the spawn of one may not have forked yet, so it is given then. `false`
/// when `p` runs no such program.
fn forward_to_program(k: &mut Kernel, p: &mut Vproc, sig: Signal, give: bool) -> bool {
	if !runs_in_place(p) {
		return false;
	}
	let Some(sc) = p.frames.last_mut().and_then(|f| f.scratch.as_mut()) else {
		return false;
	};
	let waits = sc
		.exec
		.as_deref()
		.is_some_and(|e| matches!(e.waiting, Some(proc::Awaited::Ext { .. })));
	match &mut sc.live {
		Live::Ext(ext) if waits => {
			if give {
				let _ = ext.signal(sig);
			}
			true
		},
		Live::Spawn(_) => {
			k.forward = k.forward.with(sig);
			true
		},
		_ => false,
	}
}

/// Whether `p`'s innermost frame runs, or is starting, an external in place
/// of the shell: one it `exec`s, or one the real shell runs without a fork
/// ([`proc::ExecState::in_place`]).
fn runs_in_place(p: &Vproc) -> bool {
	p.frames
		.last()
		.and_then(|f| f.scratch.as_ref())
		.and_then(|sc| sc.exec.as_deref())
		.is_some_and(|e| e.in_place || matches!(e.control, Some(proc::Transfer::Exec)))
}

/// Pass `sig` on to the builtin tasks and externals `p` runs now, and
/// continue the externals after it when `cont` (bash's `kill_pid` continues
/// a stopped job it ends).
fn signal_lives(p: &mut Vproc, sig: Signal, cont: bool) {
	for frame in &mut p.frames {
		if let Some(sc) = frame.scratch.as_mut() {
			match &mut sc.live {
				Live::Task(task) => task.signal(sig),
				Live::Ext(ext) => {
					let _ = ext.signal(sig);
					if cont {
						let _ = ext.cont();
					}
				},
				_ => {},
			}
		}
	}
}

/// Whether a terminating signal to `p` is the business of what `p` runs
/// rather than of `p` itself, as when bash runs it in `p`'s own process:
/// `Some(true)` when `p` is a subshell vproc (no `EXIT` trap of its own)
/// whose one frame awaits the external bash runs with `exec` there (bash:
/// [`killed::subshell_exec`], decided as it started; zsh: its last command,
/// `cmd &`, a pipeline stage, `( cmd )`) or one it `exec`s; `Some(false)`
/// when it only waits for the stages of its pipeline or its `( … )` (with
/// that command's redirections, `( list ) >file &`) before it exits (the job
/// vproc of `a | b &`; bash: only a pipeline or a `( … )` that is its whole
/// command, which bash runs in that process, `( ( … ) )`, but not a timed
/// one in a `( … )`), and the signal reaches those too (`children`: a job,
/// label or broadcast target, or a pid target that [`Shell::deliver`]
/// forwards to its `( … )`); `None` otherwise.
pub(super) fn transparent(p: &Vproc, children: bool) -> Option<bool> {
	if !p.transient || p.own_traps.has(crate::bash::store::TrapKey::Exit) {
		return None;
	}
	let [frame] = p.frames.as_slice() else {
		return None;
	};
	let unit = frame.unit.as_ref()?;
	let sc = frame.scratch.as_ref()?;
	let op = unit.ops.get(frame.pc as usize)?;
	let code_at = |pc: u32| unit.ops.get(pc as usize).map(|op| op.code);
	let bash = p.mode.dialect() == crate::bash::ids::Dialect::Bash;
	match (&sc.live, op.code) {
		(Live::Ext(_), ir::Opcode::Exec) => {
			let exec = sc.exec.as_ref().is_some_and(|e| e.exec_as.is_some());
			let last = if bash {
				sc.exec.as_ref().is_some_and(|e| e.subshell_exec)
			} else {
				code_at(frame.pc + 1) == Some(ir::Opcode::SubExit)
			};
			(exec || last).then_some(true)
		},
		(_, ir::Opcode::Spawn) if children && !sc.children.is_empty() => {
			let spawn = unit.spawns.get(op.a as usize)?;
			let end = match (spawn.kind, code_at(spawn.end)) {
				// `( … )`: its `Leave` follows, then the `PopRedir` of its
				// redirections, if it has any.
				(ir::SpawnKind::Subshell, Some(ir::Opcode::Leave)) => {
					let after = spawn.end + 1;
					after + u32::from(code_at(after) == Some(ir::Opcode::PopRedir))
				},
				(ir::SpawnKind::Subshell | ir::SpawnKind::Pipeline, _) => spawn.end,
				_ => return None,
			};
			if bash {
				// `[Redir] Enter Spawn … Leave [PopRedir]` for a `( … )`, the
				// whole code of `p`'s own command.
				let mut start = frame.pc;
				if spawn.kind == ir::SpawnKind::Subshell {
					start = start.checked_sub(1)?;
					if start > 0 && code_at(start - 1) == Some(ir::Opcode::Redir) {
						start -= 1;
					}
				}
				let (own, i) = killed::base_spawn(unit, frame.pc)?;
				if own.stages[i].entry != start {
					return None;
				}
				// A `( … )` forks the one its body is when that one is timed:
				// `CMD_TIME_PIPELINE` keeps `execute_in_subshell` from giving
				// it `CMD_NO_FORK` (`execute_cmd.c:1799`). A job's or a stage's
				// `( … )` is that process, timed or not.
				if own.kind == ir::SpawnKind::Subshell
					&& spawn.kind == ir::SpawnKind::Subshell
					&& killed::subshell_time(unit, spawn, op.node).is_some()
				{
					return None;
				}
			}
			(code_at(end) == Some(ir::Opcode::SubExit)).then_some(false)
		},
		_ => None,
	}
}

/// Whether the `( … )` whose `Spawn` is at `pc` is the whole body of the
/// subshell, job or pipeline stage that runs it: that body's entry is the
/// `( … )`'s `Enter`, or the `Redir` of its redirections before it
/// (`[Redir] Enter Spawn … Leave [PopRedir] SubExit`; [`transparent`]
/// checks the end, and that a `( … )`'s timed one forks). bash runs such a
/// `( … )` in the process of that body (`execute_in_subshell` gives a body
/// that is one untimed `cm_subshell` `CMD_NO_FORK`, and does its
/// redirections first); after another command, as in `( :; ( list ) )`, it
/// forks.
fn whole_stage(unit: &Unit, pc: u32) -> bool {
	let code_at = |pc: u32| unit.ops.get(pc as usize).map(|op| op.code);
	let Some(enter) = pc
		.checked_sub(1)
		.filter(|&at| code_at(at) == Some(ir::Opcode::Enter))
	else {
		return false;
	};
	let redirected = unit
		.ops
		.get(pc as usize)
		.and_then(|op| unit.spawns.get(op.a as usize))
		.is_some_and(|spawn| code_at(spawn.end + 1) == Some(ir::Opcode::PopRedir));
	let entry = if redirected {
		match enter.checked_sub(1) {
			Some(at) if code_at(at) == Some(ir::Opcode::Redir) => at,
			_ => return false,
		}
	} else {
		enter
	};
	unit
		.spawns
		.iter()
		.any(|spawn| spawn.stages.iter().any(|stage| stage.entry == entry))
}

/// Whether `p` only waits for the one `( … )` that is its whole command
/// ([`transparent`]'s `Some(false)` for a `( … )`): bash runs that
/// subshell in `p`'s own process (`execute_in_subshell`'s `CMD_NO_FORK`).
fn waits_for_its_subshell(p: &Vproc) -> bool {
	p.mode.dialect() == crate::bash::ids::Dialect::Bash
		&& transparent(p, true) == Some(false)
		&& p.frames.first().is_some_and(|f| {
			f.unit.as_ref().is_some_and(|u| {
				u.ops
					.get(f.pc as usize)
					.and_then(|op| u.spawns.get(op.a as usize))
					.is_some_and(|s| s.kind == ir::SpawnKind::Subshell)
			})
		})
}

/// Whether `p` is just the job process of a pipeline (`a | b &`): its one
/// frame waits for the stages and exits after them ([`transparent`]'s
/// `Some(false)`). bash's job is that pipeline's processes
/// ([`proc::Job::procs`]): a signal that ends this vproc itself ends none of
/// them.
fn runs_pipeline(p: &Vproc) -> bool {
	let [frame] = p.frames.as_slice() else {
		return false;
	};
	transparent(p, true) == Some(false)
		&& frame.unit.as_ref().is_some_and(|unit| {
			unit
				.ops
				.get(frame.pc as usize)
				.and_then(|op| unit.spawns.get(op.a as usize))
				.is_some_and(|spawn| matches!(spawn.kind, ir::SpawnKind::Pipeline))
		})
}

/// `vp` spawned the program of OS pid `pid`: where `vp` is a pipeline's
/// stage that is just that program (bash's process for the stage `exec`s
/// it, [`transparent`]), the record of the process the stage is
/// ([`proc::JobProc`]) is known by that pid ([`Kernel::settled`]).
pub(super) fn stage_spawned(k: &mut Kernel, vp: &Vproc, pid: u32) {
	let stage = vp.parent.is_some()
		&& transparent(vp, false) == Some(true)
		&& vp.frames.first().is_some_and(|f| {
			f.unit
				.as_deref()
				.and_then(|u| killed::base_spawn(u, f.pc))
				.is_some_and(|(s, _)| s.kind == ir::SpawnKind::Pipeline)
		});
	if stage {
		k.settled.push((vp.vpid, pid));
	}
}

fn set_stopped(p: &mut Vproc, on: bool) {
	p.stopped = on;
	pause_handles(p, on);
}

/// Pause or resume a vproc's task or external.
fn pause_handles(p: &mut Vproc, on: bool) {
	for f in &mut p.frames {
		if let Some(sc) = f.scratch.as_mut() {
			match &mut sc.live {
				Live::Task(t) if on => t.pause(),
				Live::Task(t) => t.resume(),
				Live::Ext(e) if on => {
					let _ = e.stop();
				},
				Live::Ext(e) => {
					let _ = e.cont();
				},
				_ => {},
			}
		}
	}
}

/// What a submitted script changes in the state its new subshell forks
/// ([`Script::env`], [`Script::foreign_env`], [`Script::unexport_env`],
/// [`Script::args`], [`Script::as_program`]).
struct ForkEdits {
	env:          Vec<(BString, BString)>,
	foreign_env:  Vec<(Option<BString>, Option<BString>)>,
	unexport_env: Vec<BString>,
	args:         Option<Vec<BString>>,
	/// The caller's exported functions (name, value), for a program's
	/// children's environment ([`Script::as_program`]).
	exported:     Vec<(BString, BString)>,
	/// [`Script::as_program`]: the subshell hides the caller's DEBUG, ERR and
	/// RETURN traps, xtrace, `enable -n`, functions and aliases.
	as_program:   bool,
}

impl ForkEdits {
	/// Apply the changes to `vp`, a subshell holding its forked state.
	fn apply(self, vp: &mut Vproc) {
		// A locale variable among them: the subshell no longer has its
		// parent's locale values (`state::locale_token`).
		if self
			.env
			.iter()
			.map(|(name, _)| name)
			.chain(&self.unexport_env)
			.any(|name| state::is_locale_name(name))
		{
			vp.locale_gen = None;
		}
		let Some(image) = vp.image.as_mut() else {
			return;
		};
		if !self.foreign_env.is_empty() || !self.exported.is_empty() {
			let mut foreign = match image.get(Key::Misc(MiscKey::ForeignEnv)) {
				Some(Record::Words(entries)) => entries.clone(),
				_ => Vec::new(),
			};
			for (name, value) in self.exported {
				foreign.retain(|entry| entry.split(|&b| b == b'=').next() != Some(name.as_slice()));
				let mut entry = name;
				entry.push(b'=');
				entry.extend_from_slice(&value);
				foreign.push(entry);
			}
			for (name, value) in self.foreign_env {
				if let Some(name) = name {
					foreign.retain(|entry| entry.split(|&b| b == b'=').next() != Some(name.as_slice()));
					if let Some(value) = value {
						let mut entry = name;
						entry.push(b'=');
						entry.extend_from_slice(&value);
						foreign.push(entry);
					}
				} else {
					foreign.clear();
				}
			}
			image.put(Key::Misc(MiscKey::ForeignEnv), Record::Words(foreign));
		}
		for (name, value) in self.env {
			if is_ident(&name) {
				image.set_var(&name, Some(Var::scalar(value, Attrs::EXPORT)));
			}
		}
		for name in self.unexport_env {
			image.del_var(&name);
			for scope in &mut vp.scopes {
				if let Some(var) = scope.vars.var_mut(&name) {
					var.attrs = var.attrs.without(Attrs::EXPORT);
				}
			}
		}
		if self.as_program {
			use crate::bash::store::{Table, TrapKey};
			// No record in the image: the caller's trap is unset here.
			for key in [TrapKey::Debug, TrapKey::Err, TrapKey::Return] {
				image.del(Key::Trap(key));
			}
			// A program's children neither trace nor see the caller's
			// `enable -n`.
			image.put(Key::Opt(OptId::Xtrace), Record::Opt(false));
			image.put(Key::Misc(MiscKey::DisabledBuiltins), Record::Words(Vec::new()));
			// Nor its functions and aliases, removed the same way: one the
			// subshell defines is its own.
			let mut hidden = Vec::new();
			for table in [Table::Func, Table::Alias, Table::ZshAlias] {
				image.each_record(table, &mut |key, _| hidden.push(key.to_buf()));
			}
			for key in hidden {
				image.del(key.as_key());
			}
		}
		if let Some(args) = self.args {
			// A copied function scope takes precedence: install the
			// script's arguments at that level, as `set --` does.
			match vp.scopes.iter_mut().rev().find(|s| s.positional.is_some()) {
				Some(scope) => scope.positional = Some(args),
				None => {
					if let Some(image) = vp.image.as_mut() {
						image.put(Key::Misc(MiscKey::Positional), Record::Words(args));
					}
				},
			}
		}
	}
}

impl Vproc {
	fn new(
		vpid: Vpid,
		parent: Option<Vpid>,
		fds: FdTable,
		cwd: BString,
		image: Option<Image>,
		transient: bool,
	) -> Self {
		Self {
			vpid,
			parent,
			runs: VecDeque::new(),
			frames: Vec::new(),
			scopes: Vec::new(),
			fds,
			cwd,
			status: 0,
			pipestatus: Vec::new(),
			image,
			locale_gen: None,
			out: VecDeque::new(),
			blocked: None,
			pending_traps: crate::bash::signal::SigSet::EMPTY,
			stopped: false,
			transient,
			exit_trap_due: true,
			jobs: proc::JobTable::default(),
			last_bg: proc::LastBg::default(),
			lineage: crate::bash::host::Lineage::default(),
			trace_base: 0,
			subshell: 0,
			outer_loops: 0,
			command: None,
			command_name: None,
			trap_saved: 0,
			spare: Vec::new(),
			calls: Vec::new(),
			own_traps: proc::OwnTraps::EMPTY,
			async_ignored: proc::AsyncIgnored::NONE,
			trap_frames: 0,
			pending_break: None,
			mode: ModeId::Bash,
			zsh: None,
			zle: None,
			clock: None,
			rare: None,
		}
	}

	/// A child of `self` (subshell, pipeline stage, background job, command
	/// substitution) that starts running `unit` at `entry` with `fds`.
	pub fn child(
		&self,
		k: &mut Kernel,
		store: &mut dyn StateStore,
		unit: Arc<Unit>,
		entry: u32,
		fds: FdTable,
	) -> Self {
		self.child_as(k, store, unit, entry, fds, None)
	}

	/// [`Self::child`] with the vpid `vpid` reserved for it (a stage of a
	/// background pipeline job, [`Kernel::stage_vpids`]), else a new one.
	pub fn child_as(
		&self,
		k: &mut Kernel,
		store: &mut dyn StateStore,
		unit: Arc<Unit>,
		entry: u32,
		fds: FdTable,
		vpid: Option<Vpid>,
	) -> Self {
		let line_shift = self.frames.last().map_or(0, |f| f.line_shift);
		// bash's `line_number` as it forks: a `( … )`'s own line, the last
		// (`Subshell->line`; its body follows its `Spawn` op), else the line
		// the parent has reached ([`killed::wait_line`]).
		let fork_line = entry
			.checked_sub(1)
			.and_then(|pc| unit.ops.get(pc as usize))
			.filter(|op| {
				op.code == ir::Opcode::Spawn
					&& unit
						.spawns
						.get(op.a as usize)
						.is_some_and(|s| s.kind == ir::SpawnKind::Subshell)
			})
			.map_or_else(
				|| {
					let node = self
						.frames
						.last()
						.and_then(|f| f.unit.as_ref()?.ops.get(f.pc as usize))
						.map_or(0, |op| op.node);
					killed::wait_line(self, node)
				},
				|op| (unit.line + exec::end_line(&unit, op.node)).saturating_sub(line_shift),
			);
		let mut frame = Frame::new(Some(unit), entry, proc::FrameKind::Subshell);
		// A subshell runs code of the same unit: it keeps the line numbering.
		frame.line_shift = line_shift;
		frame.fork_line = Some(fork_line);
		self.child_running(k, store, fds, frame, vpid)
	}

	/// A subshell of `self` that parses and runs `src` from script line
	/// `line` (a `$( )` re-parsed with the aliases in effect).
	pub fn child_text(
		&self,
		k: &mut Kernel,
		store: &mut dyn StateStore,
		src: &[u8],
		line: u32,
		fds: FdTable,
	) -> Self {
		let kind = proc::FrameKind::script(
			src,
			crate::bash::syntax::Pos { offset: 0, line },
			proc::ScriptKind::Eval,
		);
		self.child_running(k, store, fds, Frame::new(None, 0, kind), None)
	}

	/// A subshell of `self` with `fds` whose first frame is `frame`, of vpid
	/// `vpid` or a new one; it starts with a copy of `self`'s function scopes
	/// (the root's are read from the store).
	fn child_running(
		&self,
		k: &mut Kernel,
		store: &mut dyn StateStore,
		fds: FdTable,
		mut frame: Frame,
		vpid: Option<Vpid>,
	) -> Self {
		let vpid = vpid.unwrap_or_else(|| k.vpid(store));
		let (image, locale_gen) = state::fork_image(&k.root, store, self).unwrap_or_else(|err| {
			k.fail(err);
			(Image::default(), None)
		});
		let mut vp = Self::new(vpid, Some(self.vpid), fds, self.cwd.clone(), Some(image), true);
		vp.locale_gen = locale_gen;
		// `$BASH_SUBSHELL`: one more than the parent's (a pipeline stage
		// or background job adjusts it, `exec::spawn`). The parent's
		// caught-signal traps stay in the image: the child lists them but
		// does not run them (`state::inherited_trap`).
		set_subshell_depth(&mut vp, subshell_depth(self).saturating_add(1));
		// A subshell catches its own fatal errors (bash
		// `execute_in_subshell`); `exec::forked_for` marks a fork's.
		vp.set_fork(proc::Fork::CHILD);
		// A fork whose trap strings are still to reset (bash's
		// `SUBSHELL_RESETTRAP`, [`proc::OwnTraps::reset_pending`]).
		vp.own_traps = vp.own_traps.with_reset_pending(true);
		vp.status = self.status;
		vp.scopes = state::copy_scopes(&k.root, store, self).unwrap_or_else(|err| {
			k.fail(err);
			Vec::new()
		});
		// Exact: `clone_from` into the empty vector reserves four slots.
		vp.pipestatus.reserve_exact(self.pipestatus.len());
		vp.pipestatus.extend_from_slice(&self.pipestatus);
		// `$!` is a parameter every subshell copies; `wait` and `kill`
		// still check that the child it names is this vproc's own.
		vp.last_bg = self.last_bg;
		vp.set_getopts(self.getopts().clone());
		vp.command.clone_from(&self.command);
		vp.command_name = self.command_name;
		vp.trap_saved = self.trap_saved;
		vp.set_rlimits(self.rlimits().to_vec());
		vp.lineage = self.lineage;
		jobctl::inherit(k, vp.vpid, self.vpid);
		vp.mode = self.mode;
		vp.zle.clone_from(&self.zle);
		// `$RANDOM`'s generator and `$SECONDS`' origin are process state:
		// the child gets a copy (bash code reseeds it on first use), and so
		// is whether `unset` removed their special meaning.
		vp.clock = Some(k.fork_clock(self));
		vp.set_sticky(self.sticky().cloned());
		// zsh forks keep `scriptname`: diagnostics of the child name the
		// parent's function, `(eval)` or file.
		if self.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			let site = k.zsh_site_base(store, self);
			let z = vp.zsh.get_or_insert_with(Box::default);
			z.site = Some(site);
			z.context = zsh::specials::eval_context(self);
			if let Some(parent) = self.zsh.as_deref() {
				z.ptys.clone_from(&parent.ptys);
				z.curses.clone_from(&parent.curses);
				z.last_math = parent.last_math;
			}
		}
		// The session's terminal (a `zpty` slave) whatever the mode.
		if let Some(tty) = self.zsh.as_deref().and_then(|z| z.ctty.0.clone()) {
			vp.zsh.get_or_insert_with(Box::default).ctty = proc::Ctty(Some(tty));
		}
		// bash `without_job_control`: no jobs, no job control (a command
		// substitution turns it back on when it starts).
		vp.jobs.subshell = true;
		// zsh `clearjobtab`: a fork of a shell doing job control keeps a
		// copy of its job table to report (`jobs`, `$jobstates`).
		if self.mode.dialect() == crate::bash::ids::Dialect::Zsh
			&& !self.jobs.is_empty()
			&& state::option(&mut k.root, store, self, OptId::Monitor).unwrap_or(false)
		{
			vp.jobs = exec::inherited_jobs(self, true);
		}
		// bash's fork keeps `jobs_list_frozen` (`execute_in_subshell`'s
		// `without_job_control` empties the list but leaves the freeze), and
		// nothing in it ends that freeze: for its whole life it deletes no
		// job, and a command or process substitution it starts drops none
		// ([`proc::JobTable::freeze`]).
		vp.jobs.freeze = self.freeze();
		// A fork of a command or process substitution is not one (bash
		// `execute_in_subshell` starts a new `subshell_environment`); the
		// substitution sets its own process's ([`exec::start_sub`],
		// [`exec::start_procsub`]).
		vp.jobs.comsub = self.jobs.comsub.forked();
		// bash: a fork of an asynchronous command that trapped a signal it
		// ignored with an action starts with that signal at its default.
		exec::fork_async_ignored(k, store, self, &mut vp);
		vp.calls = callstack::inherited(self);
		vp.trace_base = xtrace::level(self) - 1;
		// bash's fork copies `top_level`: a fatal error in a forked simple
		// command ends where its forking shell's would have.
		frame
			.flags
			.set_command_loop(exec::fatal_reaches_command_loop(self));
		// Started from a context where `set -e` is ignored (the parent's op
		// is a condition, or its frame runs in one): so is the child.
		frame.ignore_errexit = self.frames.last().is_some_and(exec::errexit_ignored);
		// bash's fork keeps `parse_and_execute_level`: a child started
		// inside an `eval`, `.` or trap action (or a child of one) runs
		// inside that level; one started inside a substitution's text keeps
		// the substitution's jump target, and one whose outermost level is
		// an EXIT trap action keeps that trap's ([`exec::fork_level`]).
		frame.flags.set_parse_level(exec::fork_level(store, self));
		// Room for exactly this frame: a `Frame` is ~300 bytes and a first
		// push reserves four (idle vproc ≤ 2,048 B back to back); calls grow it.
		vp.frames.reserve_exact(1);
		vp.frames.push(frame);
		vp
	}
}

/// `$BASH_SUBSHELL` of `vp` ([`Vproc::subshell`]); zero for the shell
/// itself and a nested shell.
pub const fn subshell_depth(vp: &Vproc) -> u32 {
	vp.subshell & proc::SUBSHELL_DEPTH
}

/// Set `vp`'s `$BASH_SUBSHELL` (a vproc without an image is the shell
/// itself and stays at zero). Called by `child_running` and by
/// `exec::spawn` for pipeline stages and background jobs.
pub const fn set_subshell_depth(vp: &mut Vproc, depth: u32) {
	if vp.image.is_some() {
		vp.subshell = (vp.subshell & !proc::SUBSHELL_DEPTH) | (depth & proc::SUBSHELL_DEPTH);
	}
}

/// Scope of an assignment made by `vp`.
pub const fn assign_scope(vp: &Vproc) -> AssignScope {
	if vp.image.is_some() {
		AssignScope::Subshell
	} else {
		AssignScope::Global
	}
}

// Failure mode: a run cancelled, or ended by a signal to the shell, while
// its `jobs` waited on its take-in (the ask made, or made and answered)
// left the ask in `Kernel::exits_asked` or the answer in
// `Kernel::exits_taken`; `Kernel::asking` then held every later signal trap
// of the root for good: the next run's `USR1` trap never ran (the
// reviewer's probe at 2bfc6ca3: `tail` alone). In the bash tool's shell a
// timed-out command would silence the session's traps.
#[cfg(test)]
mod cancelled_take_in {
	use super::*;
	use crate::testkit::{FakeHost, Fault, Rig, fault::skeleton_init};

	/// What ends the run while its `jobs` waits on the take-in.
	#[derive(Clone, Copy, Debug)]
	enum End {
		/// The host cancels the run (a timeout): the cancel's handling.
		Cancel(Signal),
		/// A signal sent to the shell's pid: `Shell::kill` of the root.
		Signal(Signal),
	}

	/// `while :; do :; done & jobs` one op per step until the root's `jobs`
	/// has its answer (`answered`), or has asked and waits for it; then
	/// `end`; then `USR1` is pending for the next run. That run's output.
	/// The ask waits only when the loop has had a turn before it (`(:)`
	/// first): a job that has not run yet is owed none, so an ask right
	/// after `&` is answered in the step that makes it.
	fn end_at_the_ask(answered: bool, end: End) -> Vec<u8> {
		let mut rig = Rig::new(FakeHost::default(), skeleton_init(&[]));
		assert_eq!(rig.run(Script::command(b"trap 'echo signal' USR1".to_vec()), Fault::None), 0);
		let root = rig.shell().procs[0].vpid;
		let src: &[u8] = if answered {
			b"while :; do :; done & jobs"
		} else {
			b"while :; do :; done & (:); jobs"
		};
		let run = rig.shell().submit(Script::command(src.to_vec()));
		let one = Budget { max_ops: 1, max_ns: u64::MAX };
		let mut reached = false;
		for _ in 0..50_000 {
			let (shell, host, store) = rig.parts();
			let step = shell.step(&mut Cx { host, store }, one);
			let k = &shell.k;
			if (answered && k.exits_taken.contains(&root))
				|| (!answered && k.exits_asked.contains(&root) && !k.exits_taken.contains(&root))
			{
				reached = true;
				break;
			}
			assert!(!matches!(step, Step::Done { run: id, .. } if id == run), "the run ended first");
		}
		assert!(reached, "`jobs` asked (answered: {answered})");
		match end {
			End::Cancel(sig) => rig.shell().k.ctl.request_cancel(sig),
			End::Signal(sig) => rig.shell().control().signal(SigTarget::Vpid(root), sig),
		}
		let mut ended = false;
		for _ in 0..50_000 {
			let (shell, host, store) = rig.parts();
			if matches!(shell.step(&mut Cx { host, store }, one), Step::Done { run: id, .. } if id == run)
			{
				ended = true;
				break;
			}
		}
		assert!(ended, "the run ends ({end:?})");
		let n = rig.host.stdout.bytes().len();
		let p = &mut rig.shell().procs[0];
		p.pending_traps = p.pending_traps.with(Signal::Usr1);
		assert_eq!(rig.run(Script::command(b"echo tail".to_vec()), Fault::None), 0);
		rig.host.stdout.bytes()[n..].to_vec()
	}

	#[test]
	fn a_cancel_after_the_answer_leaves_no_ask() {
		for sig in [Signal::Kill, Signal::Term] {
			let out = end_at_the_ask(true, End::Cancel(sig));
			assert_eq!(String::from_utf8_lossy(&out), "signal\ntail\n", "{sig:?}");
		}
	}

	#[test]
	fn a_cancel_before_the_answer_leaves_no_ask() {
		for sig in [Signal::Kill, Signal::Term] {
			let out = end_at_the_ask(false, End::Cancel(sig));
			assert_eq!(String::from_utf8_lossy(&out), "signal\ntail\n", "{sig:?}");
		}
	}

	#[test]
	fn a_signal_that_ends_the_run_at_the_ask_leaves_no_ask() {
		for answered in [true, false] {
			for sig in [Signal::Kill, Signal::Term] {
				let out = end_at_the_ask(answered, End::Signal(sig));
				assert_eq!(
					String::from_utf8_lossy(&out),
					"signal\ntail\n",
					"{sig:?} (answered: {answered})"
				);
			}
		}
	}
}

// A subshell whose last op queues its message and ends it ends once the
// message is out, also when a writer thread holds the message then. A fatal
// expansion error queues its message and unwinds every frame in one op; a
// `StdFile` on a terminal, a socket, a Linux pipe it could not reopen and
// every Darwin pipe writes through its writer thread, which can still hold
// the message when the frames are gone. The vproc, with no run and no frame,
// had no work, so no turn came to see the thread settle the message, and
// `adopt` reaps a subshell only once its queue is empty: it never ended, and
// its parent waited for it for ever. Each test holds the writer threads
// ([`crate::sys::hold_writers`], in a process of its own) while the shell
// runs as far as it can, then lets them go.
#[cfg(all(test, target_os = "linux"))]
mod ended_subshell_output {
	use std::{
		io::Read as _,
		os::unix::net::UnixStream,
		time::{Duration, Instant},
	};

	use super::*;
	use crate::testkit::{FakeHost, Rig, fault::skeleton_init};

	/// A shell whose fd 2 is a socket, which its `StdFile` writes on its
	/// writer thread; and the socket's other end.
	fn shell_with_stderr_on_a_thread() -> (Rig, UnixStream) {
		let mut rig = Rig::new(FakeHost::default(), skeleton_init(&[]));
		let (ours, peer) = UnixStream::pair().unwrap();
		peer
			.set_read_timeout(Some(Duration::from_secs(10)))
			.unwrap();
		let file = crate::sys::StdFile::new(std::fs::File::from(std::os::fd::OwnedFd::from(ours)));
		rig.shell().procs[0]
			.fds
			.set(2, Some(FdRef::open(Box::new(file), FdOrigin::Host)));
		(rig, peer)
	}

	/// Step until the shell blocks or the run ends, at most 1,000 steps: the
	/// run's status when it ended.
	fn step_until_blocked_or_done(rig: &mut Rig) -> Option<i32> {
		for _ in 0..1_000 {
			let (shell, host, store) = rig.parts();
			match shell.step(&mut Cx { host, store }, Budget::default()) {
				Step::Blocked => return None,
				Step::Done { status, .. } => return Some(status),
				_ => {},
			}
		}
		panic!("the shell neither blocked nor ended its run within 1,000 steps");
	}

	/// The socket's other end, read up to and with the first newline (each
	/// read bounded by the socket's 10 s timeout).
	fn read_line(peer: &mut UnixStream) -> String {
		let mut got = Vec::new();
		let mut byte = [0u8; 1];
		while !got.ends_with(b"\n") {
			match peer.read(&mut byte) {
				Ok(1) => got.push(byte[0]),
				Ok(_) => break,
				Err(e) => panic!("reading fd 2: {e}, after {:?}", String::from_utf8_lossy(&got)),
			}
		}
		String::from_utf8_lossy(&got).into_owned()
	}

	/// Submit `script` with the writer threads held, and step until the shell
	/// blocks: the run must not end while fd 2's message is held, and a
	/// subshell of it is still there. `edit` changes the shell then. Also the
	/// kernel's wake count just before the threads are let go: the thread's
	/// wake can come as soon as they are.
	fn run_until_held(script: &[u8], edit: impl FnOnce(&mut Rig)) -> (Rig, UnixStream, u64) {
		let (mut rig, peer) = shell_with_stderr_on_a_thread();
		let held = crate::sys::hold_writers();
		rig.shell().submit(Script::command(script.to_vec()));
		assert_eq!(
			step_until_blocked_or_done(&mut rig),
			None,
			"the run ended while its message to fd 2 was held"
		);
		assert!(
			rig.shell().procs.iter().any(|p| p.transient),
			"no subshell left while its message to fd 2 was held"
		);
		edit(&mut rig);
		let before = rig.shell().k.ctl.wakes();
		drop(held);
		(rig, peer, before)
	}

	/// Let fd 2's line out (it ends with `message`), wait for the writer
	/// thread's wake past `before` (it marks the chunk done, then wakes the
	/// kernel), then step: the run must end without the shell blocking, since
	/// nothing it waits for is left. Its status and stdout.
	fn finish_after_the_line(
		(mut rig, mut peer, before): (Rig, UnixStream, u64),
		message: &str,
	) -> (i32, String) {
		let line = read_line(&mut peer);
		assert!(line.ends_with(message), "fd 2 got {line:?}, not a line ending {message:?}");
		let deadline = Instant::now() + Duration::from_secs(10);
		while rig.shell().k.ctl.wakes() == before {
			assert!(Instant::now() < deadline, "DEADLINE: the writer thread did not wake the kernel");
			std::thread::sleep(Duration::from_millis(1));
		}
		for _ in 0..1_000 {
			let (shell, host, store) = rig.parts();
			match shell.step(&mut Cx { host, store }, Budget::default()) {
				Step::Done { status, .. } => {
					return (status, String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned());
				},
				Step::Blocked => panic!(
					"the shell blocked with fd 2's line out and nothing left to wait for: the ended \
					 subshell was never reaped (stdout {:?})",
					String::from_utf8_lossy(&rig.host.stdout.bytes())
				),
				_ => {},
			}
		}
		panic!("the run did not end within 1,000 steps of fd 2's line going out");
	}

	/// A fatal expansion error in a subshell, a command substitution and a
	/// background job: each ends once its message is out, with bash's status.
	#[test]
	fn a_fatal_message_held_by_the_writer_thread_ends_its_subshell_once_out() {
		crate::sys::in_blocking_writer_process(
			concat!(
				module_path!(),
				"::a_fatal_message_held_by_the_writer_thread_ends_its_subshell_once_out"
			),
			|| {
				for script in [
					&b"( : ${x:?u} ); echo \"st=$?\""[..],
					b"v=$(: ${x:?u}); echo \"st=$?\"",
					b"( : ${x:?u} ) & wait $!; echo \"st=$?\"",
				] {
					let held = run_until_held(script, |_| {});
					let got = finish_after_the_line(held, "line 1: x: u\n");
					assert_eq!(got, (0, "st=1\n".to_owned()), "{}", String::from_utf8_lossy(script));
				}
			},
		);
	}

	/// The control: a subshell's write that is not its last op (`echo e >&2`
	/// settles before the subshell goes on) ended before the fix and still
	/// does, once its line is out and not before.
	#[test]
	fn a_subshells_write_that_is_not_its_last_op_ends_it_once_out() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_subshells_write_that_is_not_its_last_op_ends_it_once_out"),
			|| {
				let held = run_until_held(b"( echo e >&2 ); echo \"st=$?\"", |_| {});
				assert_eq!(finish_after_the_line(held, "e\n"), (0, "st=0\n".to_owned()));
			},
		);
	}

	/// A signal trap pending in a subshell that has ended and only waits for
	/// its message to go out does not run there: the vproc's turns are for
	/// the message alone, as bash's child, gone, runs nothing.
	#[test]
	fn an_ended_subshells_pending_trap_does_not_run() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::an_ended_subshells_pending_trap_does_not_run"),
			|| {
				let held =
					run_until_held(b"( trap 'echo trapped' USR1; : ${x:?u} ); echo \"st=$?\"", |rig| {
						let p = rig
							.shell()
							.procs
							.iter_mut()
							.find(|p| p.transient)
							.expect("the subshell");
						p.pending_traps = p.pending_traps.with(Signal::Usr1);
					});
				assert_eq!(finish_after_the_line(held, "line 1: x: u\n"), (0, "st=1\n".to_owned()));
			},
		);
	}

	/// A cancel (`TERM`) while an ended subshell's message is held starts no
	/// trap in that subshell: it has no code left to run one in, and is ended
	/// with the run. The cancelled run's end is reported before any other
	/// vproc runs again, so the shell is stepped on until it idles: a trap
	/// started in the subshell would run then.
	#[test]
	fn a_cancel_runs_no_trap_in_an_ended_subshell() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_cancel_runs_no_trap_in_an_ended_subshell"),
			|| {
				let (mut rig, mut peer, _) =
					run_until_held(b"( trap 'echo trapped' TERM; : ${x:?u} ); echo \"st=$?\"", |rig| {
						rig.shell().k.ctl.request_cancel(Signal::Term);
					});
				let line = read_line(&mut peer);
				assert!(line.ends_with("line 1: x: u\n"), "fd 2 got {line:?}");
				let (mut ended, mut idle) = (false, false);
				for _ in 0..1_000 {
					let (shell, host, store) = rig.parts();
					match shell.step(&mut Cx { host, store }, Budget::default()) {
						Step::Done { .. } => ended = true,
						Step::Idle if ended => {
							idle = true;
							break;
						},
						_ => {},
					}
				}
				assert!(ended && idle, "the cancelled run did not end and idle within 1,000 steps");
				let out = String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned();
				assert!(!out.contains("trapped"), "a trap ran in the ended subshell: stdout {out:?}");
			},
		);
	}
}
