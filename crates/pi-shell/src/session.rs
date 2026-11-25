//! A persistent engine shell driven per command.
//!
//! **Threading.** The engine is step-driven and synchronous: [`Shell::step`]
//! runs a budget of work and returns, and everything it waits on (pipes,
//! externals, pending filesystem operations, timers) wakes a waker. A
//! [`Session`] gives the shell, its [`MemStore`] and its [`PiHost`] to one
//! task (the *driver*) on [`SessionConfig::runtime`], which steps the shell
//! and, while every virtual process waits, suspends on the engine's waker, a
//! wake bell (requests, cancellation, tool completion) and the next tool
//! deadline. Nothing blocks a thread: a current-thread runtime drives the
//! driver, the provider futures of a `pi_vfs`-backed [`Fs`], external
//! spawning and output pumps together, and a step that exhausts its budget
//! yields to the runtime. The async side ([`Session::run`]) only sends jobs
//! over a channel and awaits the reply. Between commands the driver keeps
//! stepping background work (`cmd &` in-engine jobs, reaping background
//! externals).
//! **State.** Variables, functions, aliases, options, traps and the working
//! directory live in the store and the root virtual process; every command
//! runs on the root ([`VprocSel::Root`]), so they persist across commands.
//! An `EXIT` trap is consumed when it fires at a run boundary; other traps
//! remain installed.
//! Each command starts with its own standard streams, even if an earlier
//! command redirected them with `exec`. Higher-numbered descriptors persist;
//! duplicates of standard streams follow the current command's streams.
//! The root lets go of a command's standard streams when it ends, as a
//! `bash -c` shell's exit closes its own, but they stay open while a
//! process substitution the command started still runs
//! (`cmd > >(slow-reader)`, `exec > >(tee log)`): its output reaches the
//! caller after the command, as bash's does.
//!
//! **Forks.** Between engine calls the store holds the whole root state, so
//! the driver publishes a copy of it at each command boundary
//! ([`Session::latest_image`]); [`Session::restore`] starts a second session
//! from that copy while the first one keeps running its command.
//!
//! **`exit`.** A root run is a `bash -c` script: `exit N` (or `set -e`)
//! unwinds the run with status `N`, runs the `EXIT` trap at the run boundary,
//! and the shell stays usable for the next command with its state intact
//! (pi's `exit_and_errexit_keep_session_state`). The engine does this
//! itself; the session only reports the status.
//!
//! **Cancellation.** A cancelled run is stopped through the engine's
//! [`ControlHandle::cancel`](crate::bash::ControlHandle::cancel): first `TERM`
//! (signal traps run, externals get `TERM`, status 143), then, if the run
//! has not ended after [`TERM_GRACE`](crate::host::TERM_GRACE), `KILL` (no
//! traps, status 137). Unwinding drops the externals the run waits for; the
//! spawner sends their process groups `TERM` and `KILL` after
//! [`TERM_GRACE`](crate::host::TERM_GRACE) in the background. The cancel
//! request reaches the engine only from the driver, while the run it targets is
//! still in flight, so a late cancel never leaks into the next command. What
//! `nohup` started ([`crate::tools`]) is detached: neither a cancel nor closing
//! the session ends it. Background jobs an earlier command left running are not
//! part of the cancelled one: a cancel spares them, but closing the session
//! ends them.
//!
//! **Subshell jobs.** Unlike bash, a subshell's background jobs that run
//! in-engine work (builtins, loops) end when the subshell exits
//! ([`EngineConfig::end_orphan_jobs`]): no process stands for them, so
//! nothing could reach them afterwards. A job that is just an external runs
//! on as its own process, as in bash.
//!
//! **Tools.** `timeout`, `nohup` and (with `PI_SMART_GIT`/`PI_GIT_GUARD`)
//! `git` are host callouts: the driver hands them to its
//! [`ToolCalls`](crate::tools::ToolCalls), routes the `Done` of their
//! subshells there, polls them every turn, and parks no longer than their
//! next deadline.

use std::{
	future::poll_fn,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU8, Ordering},
	},
	task::{Wake, Waker},
	time::Duration,
};

use bstr::{BString, ByteSlice};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{
	bash::{
		Budget, CallId, Cx, Engine, EngineConfig, EventMask, EventSink, Fs, MemStore, PipeTap,
		Profile, RestoreError, RestoreOpts, RunId, Script, Shell, ShellError, ShellInit, Signal,
		Step, ToolCall, Vpid, VprocSel,
		store::{Key, MiscKey, Record},
	},
	host::{HeldRun, PiHost, SpawnObserver},
	sys::OutputDecoding,
	tools::{ToolCalls, ToolConfig},
	vfs::VfsFs,
};

/// How long a run may take to end after the `KILL` cancel before the session
/// gives up on it ([`SessionError::Unresponsive`]).
const KILL_WAIT: Duration = Duration::from_secs(5);

/// Most default-budget steps of background work a command's end waits for
/// ([`Driver::settle`]): about 8 ms.
const SETTLE_STEPS: u32 = 4;

/// Longest suspension of the driver: every wake it waits for is delivered by
/// a waker, so this only bounds the cost of a lost one.
const MAX_PARK: Duration = Duration::from_secs(1);

/// Configuration of a new [`Session`].
pub struct SessionConfig {
	/// The shell's initial environment, all exported (no inheritance from
	/// the pi process beyond what is listed).
	pub env:             Vec<(BString, BString)>,
	/// Initial working directory (absolute).
	pub cwd:             BString,
	/// The filesystem: `crate::vfs::VfsFs`, or `crate::sys::StdFs`.
	pub fs:              Box<dyn Fs + Send>,
	/// The pi-vfs filesystem slot behind [`SessionConfig::fs`] (a clone of
	/// the same [`VfsFs`]), when there is one: pi's utilities and in-process
	/// `git worktree add` ([`crate::tools`]) work on the filesystem it holds
	/// when they run, and externals get the host files its URLs alias
	/// ([`PiHost::spawn`](crate::bash::Host::spawn)). `None`: every path is
	/// native.
	pub vfs:             Option<VfsFs>,
	/// Runtime the host's timers (`read -t`, `TMOUT`) sleep on.
	pub runtime:         tokio::runtime::Handle,
	/// Decodes what externals write into a text capture
	/// ([`RunOptions::text_capture`]); `None` is the platform default
	/// ([`crate::output_decode::external_output_decoding`]).
	pub output_decoding: Option<Arc<dyn OutputDecoding>>,
	/// How long a cancelled run's externals have between TERM and KILL, and
	/// [`Session::run_with`] between its TERM and its KILL of the run:
	/// pi's [`TERM_GRACE`](crate::host::TERM_GRACE), or what this session
	/// was given (a test that drives what happens inside the grace).
	pub term_grace:      Duration,
}

/// One command of a [`Session`].
#[derive(Clone, Default)]
pub struct RunOptions {
	/// The command string (`bash -c` semantics).
	pub command:        String,
	/// Variables exported to this command only (pi's per-run env). They are
	/// visible to everything the command runs; afterwards each named
	/// variable is back to what it was before, whatever the command did to
	/// it.
	pub env:            Vec<(BString, BString)>,
	/// Working directory to change to before the command (absolute, or a
	/// `scheme://` URL path the filesystem serves); like `cd`, it persists.
	pub cwd:            Option<BString>,
	/// Gets a copy of the bytes crossing the pipes of the command's pipelines
	/// ([`crate::bash::Host::pipe_tap`]); pipelines it leaves running in the
	/// background stay tapped.
	pub pipe_tap:       Option<Arc<dyn PipeTap>>,
	/// Set when a utility reports an error its exit status hides (`jq`
	/// after a failing input that is not the last).
	pub reported_error: Option<Arc<AtomicBool>>,
	/// The command's stdout and stderr are one pipe whose reader takes its
	/// bytes as shell text: what externals write there is decoded per
	/// program by the host's output decoding
	/// ([`PiHost::set_output_decoding`](crate::host::PiHost::set_output_decoding)),
	/// through one relay for both streams. Pipeline pipes and files are
	/// never decoded.
	pub text_capture:   bool,
	/// Observes the engine events of this command (a
	/// [`RunTrace`](crate::bash::trace::RunTrace)); the shell's event mask
	/// is the sink's while the command runs and `NONE` otherwise. Each
	/// observer receives units lazily, including persistent function bodies
	/// only when this command executes them.
	pub events:         Option<Arc<dyn EventSink>>,
}

impl RunOptions {
	/// Run `command` with no env overlay in the current directory.
	pub fn new(command: impl Into<String>) -> Self {
		Self {
			command:        command.into(),
			env:            Vec::new(),
			cwd:            None,
			pipe_tap:       None,
			reported_error: None,
			text_capture:   false,
			events:         None,
		}
	}
}

impl std::fmt::Debug for RunOptions {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("RunOptions")
			.field("command", &self.command)
			.field("env", &self.env)
			.field("cwd", &self.cwd)
			.field("pipe_tap", &self.pipe_tap.is_some())
			.field("reported_error", &self.reported_error)
			.field("events", &self.events.is_some())
			.finish()
	}
}

/// The standard streams of one command, as OS handles.
///
/// `None` behaves like `/dev/null`. The session closes its copies when the
/// command ends, so a reader of a pipe passed here sees end of file once the
/// command (and any external still holding the pipe) is done.
#[derive(Debug, Default)]
pub struct RunStdio {
	/// fd 0.
	pub stdin:  Option<std::fs::File>,
	/// fd 1.
	pub stdout: Option<std::fs::File>,
	/// fd 2.
	pub stderr: Option<std::fs::File>,
}

/// How a command ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunOutcome {
	/// Exit status, bash semantics (127 not found, 128 + n for a signal).
	pub status:    i32,
	/// The run was stopped by its cancellation token.
	pub cancelled: bool,
	/// `exit` or `set -e` ended the command (rather than its end): a caller
	/// running one command as several runs stops here, as bash would have.
	pub exited:    bool,
	/// The shell's working directory after the command.
	pub cwd:       BString,
	/// Process substitutions the command started still run and hold its
	/// stdout and stderr open (`cmd > >(slow-reader)`): they reach end of
	/// file when those end, not with the command.
	pub held:      bool,
}

/// Failure of a [`Session`] call.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
	/// The engine refused the initial state.
	#[error("could not create the shell")]
	Create(#[source] ShellError),
	/// The engine refused the [`Image`] of [`Session::restore`].
	#[error("could not restore the shell")]
	Restore(#[source] RestoreError),
	/// The driver task is gone (it panicked, or its runtime shut down), or
	/// an earlier run became
	/// [`SessionError::Unresponsive`].
	#[error("the shell session is closed")]
	Closed,
	/// A cancelled run did not end even after the `KILL` cancel; the session
	/// is closed.
	#[error("the shell did not stop after cancellation")]
	Unresponsive,
	/// [`RunOptions::cwd`] is not absolute.
	#[error("working directory {0} is not absolute")]
	RelativeCwd(BString),
}

/// The live externals of the run in flight (pi's `Shell::pids()`). Cheap to
/// clone; clones share the list.
#[derive(Clone, Default)]
pub struct Children(Arc<ChildrenState>);

#[derive(Default)]
struct ChildrenState {
	/// A run is in flight.
	active: AtomicBool,
	/// Live pids in spawn order.
	pids:   Mutex<Vec<u32>>,
}

impl Children {
	/// Pids of the live externals spawned by the run in flight, in spawn
	/// order; empty while no run is in flight.
	pub fn pids(&self) -> Vec<i32> {
		if !self.0.active.load(Ordering::Acquire) {
			return Vec::new();
		}
		self
			.0
			.pids
			.lock()
			.iter()
			.filter_map(|&pid| i32::try_from(pid).ok())
			.collect()
	}

	fn set_active(&self, active: bool) {
		self.0.active.store(active, Ordering::Release);
	}
}

impl SpawnObserver for Children {
	fn spawned(&self, pid: u32) {
		self.0.pids.lock().push(pid);
	}

	fn released(&self, pid: u32) {
		let mut pids = self.0.pids.lock();
		if let Some(i) = pids.iter().position(|&p| p == pid) {
			pids.remove(i);
		}
	}
}

/// The root state of a [`Session`] between two commands.
///
/// Variables, functions, aliases, options, traps, the working directory and
/// the job table; [`Session::restore`] starts a new session from it. Cheap to
/// clone; clones share the state.
#[derive(Clone)]
pub struct Image(Arc<MemStore>);

impl Image {
	/// The shell's working directory in this state.
	pub fn cwd(&self) -> BString {
		store_cwd(&self.0)
	}
}

/// The [`Image`] a [`Session`] published at its last command boundary.
///
/// Boundaries are its creation and the end of each command. Readable while a
/// command runs: pi forks a busy session from it. Cheap to clone; clones share
/// the slot.
#[derive(Clone)]
pub struct LatestImage(Arc<Mutex<Image>>);

impl LatestImage {
	/// The state as of the last command boundary: while a command runs, the
	/// state it started from.
	pub fn get(&self) -> Image {
		self.0.lock().clone()
	}

	fn new(store: &MemStore) -> Self {
		Self(Arc::new(Mutex::new(Image(Arc::new(store.clone())))))
	}

	fn publish(&self, store: &MemStore) {
		*self.0.lock() = Image(Arc::new(store.clone()));
	}
}

/// The shell's working directory as `store` records it.
fn store_cwd(store: &MemStore) -> BString {
	match store.record(Key::Misc(MiscKey::Cwd)) {
		Some(Record::Misc(cwd)) => cwd.clone(),
		_ => BString::default(),
	}
}

/// The wake bell of a driver task: its waker (handed to worker threads and
/// held by the [`Session`]) stores a permit the driver awaits; it never
/// blocks.
#[derive(Default)]
struct Bell(tokio::sync::Notify);

impl Wake for Bell {
	fn wake(self: Arc<Self>) {
		self.0.notify_one();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		self.0.notify_one();
	}
}

/// A persistent shell: commands run one at a time on a driver task of the
/// session's runtime (see the module docs), and state persists between them.
pub struct Session {
	/// Requests for the driver; `None` once the session is closed.
	jobs:       Option<flume::Sender<Request>>,
	/// Rings the driver's bell.
	waker:      Waker,
	children:   Children,
	image:      LatestImage,
	/// [`SessionConfig::term_grace`].
	term_grace: Duration,
	/// Test only: the shell's engine, for its test-only counts.
	#[cfg(test)]
	engine:     Arc<Engine>,
}

impl Session {
	/// Start a shell with `config`'s environment and working directory.
	///
	/// The shell is created here (no I/O) and its driver task is spawned on
	/// [`SessionConfig::runtime`], which must keep running for the session
	/// to answer.
	///
	/// # Errors
	///
	/// [`SessionError::Create`] when the engine refuses the initial state.
	pub fn new(config: SessionConfig) -> Result<Self, SessionError> {
		Self::start(config, None)
	}

	/// Start a shell from `image` (a fork of the session it came from): its
	/// variables, functions, options and working directory are the image's,
	/// so [`SessionConfig::env`] only configures pi's commands and
	/// [`SessionConfig::cwd`] is unused. Background jobs the image lists as
	/// running belong to the source session; here they are done (status
	/// 137). `$RANDOM` is reseeded.
	///
	/// # Errors
	///
	/// [`SessionError::Restore`] when the engine refuses the image.
	pub fn restore(config: SessionConfig, image: &Image) -> Result<Self, SessionError> {
		Self::start(config, Some(image))
	}

	fn start(config: SessionConfig, image: Option<&Image>) -> Result<Self, SessionError> {
		let SessionConfig { env, cwd, fs, vfs, runtime, output_decoding, term_grace } = config;
		let (jobs, rx) = flume::unbounded();
		let children = Children::default();
		let bell = Arc::new(Bell::default());
		let waker = Waker::from(Arc::clone(&bell));
		let tools = ToolConfig::from_env(&env, vfs.clone(), runtime.clone());
		let mut host = PiHost::new(fs, runtime.clone(), term_grace);
		if output_decoding.is_some() {
			host.set_output_decoding(output_decoding);
		}
		host.set_spawn_observer(Arc::new(children.clone()));
		host.set_vfs(vfs);
		host.set_tools(tools.clone());
		let tools = ToolCalls::new(tools, host.spawn_log(), waker.clone());
		// A subshell's background in-engine work ends with it: nothing
		// (no process for `pkill`, no job for `kill %N`) could reach it.
		let engine = Engine::new(EngineConfig { end_orphan_jobs: true, ..EngineConfig::default() });
		let (mut shell, store) = match image {
			None => {
				let mut store = MemStore::new();
				// A program's shell: no history, line editor or completion system.
				let init = ShellInit { env, cwd, profile: Profile::Tool, ..ShellInit::default() };
				let shell =
					Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, init)
						.map_err(SessionError::Create)?;
				(shell, store)
			},
			Some(image) => {
				let mut store = MemStore::clone(&image.0);
				let opts = RestoreOpts { reseed_random: true, ..RestoreOpts::default() };
				let (shell, _) =
					Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, opts)
						.map_err(SessionError::Restore)?;
				(shell, store)
			},
		};
		// Nothing observes events: skip building them.
		shell.set_event_mask(EventMask::NONE);
		let image = LatestImage::new(&store);
		let driver = Driver {
			shell,
			store,
			host,
			bell,
			jobs: rx,
			children: children.clone(),
			tools,
			image: image.clone(),
			held: Vec::new(),
		};
		runtime.spawn(driver.serve());
		Ok(Self {
			jobs: Some(jobs),
			waker,
			children,
			image,
			term_grace,
			#[cfg(test)]
			engine,
		})
	}

	/// Test only: the shell's engine, whose test-only counts are this
	/// session's alone.
	#[cfg(test)]
	pub(crate) fn engine(&self) -> Arc<Engine> {
		Arc::clone(&self.engine)
	}

	/// The session's state as of its last command boundary; see
	/// [`LatestImage`].
	pub fn latest_image(&self) -> LatestImage {
		self.image.clone()
	}

	/// The live externals of the run in flight; usable while
	/// [`Session::run`] borrows the session.
	pub fn children(&self) -> Children {
		self.children.clone()
	}

	/// Number of background jobs (`cmd &`) still running an external
	/// process ([`Shell::live_external_jobs`]); jobs of in-engine work only
	/// are not counted. Exited externals are reaped between commands, so
	/// a later `wait` still reports their status.
	///
	/// # Errors
	///
	/// [`SessionError::Closed`] when the session is closed.
	pub async fn live_external_jobs(&self) -> Result<usize, SessionError> {
		let jobs = self.jobs.as_ref().ok_or(SessionError::Closed)?;
		let (reply_tx, reply_rx) = flume::bounded(1);
		jobs
			.send(Request::LiveJobs(reply_tx))
			.map_err(|_| SessionError::Closed)?;
		self.waker.wake_by_ref();
		reply_rx
			.recv_async()
			.await
			.map_err(|_| SessionError::Closed)
	}

	/// Run `command` with `stdio`; see [`Session::run_with`].
	///
	/// # Errors
	///
	/// See [`Session::run_with`].
	pub async fn run(
		&mut self,
		command: &str,
		stdio: RunStdio,
		cancel: CancellationToken,
	) -> Result<RunOutcome, SessionError> {
		self.run_with(RunOptions::new(command), stdio, cancel).await
	}

	/// Run one command to completion and report how it ended.
	///
	/// When `cancel` fires the run is stopped (`TERM`, then `KILL` after
	/// [`TERM_GRACE`](crate::host::TERM_GRACE)) and the outcome says
	/// `cancelled`. Dropping the future stops the run with `KILL`. A non-zero
	/// status (`exit 3`, `set -e`, `nosuchcmd`) is an outcome, not an error: the
	/// session stays usable.
	///
	/// # Errors
	///
	/// [`SessionError::RelativeCwd`] for a relative [`RunOptions::cwd`];
	/// [`SessionError::Closed`] when the session is closed;
	/// [`SessionError::Unresponsive`] (closing the session) when a cancelled
	/// run does not end.
	pub async fn run_with(
		&mut self,
		options: RunOptions,
		stdio: RunStdio,
		cancel: CancellationToken,
	) -> Result<RunOutcome, SessionError> {
		if let Some(cwd) = &options.cwd
			&& !is_absolute(cwd)
		{
			return Err(SessionError::RelativeCwd(cwd.clone()));
		}
		let jobs = self.jobs.as_ref().ok_or(SessionError::Closed)?;
		let level = Arc::new(CancelLevel::default());
		let (reply_tx, reply_rx) = flume::bounded(1);
		let job = Job { options, stdio, cancel: Arc::clone(&level), reply: reply_tx };
		jobs
			.send(Request::Run(job))
			.map_err(|_| SessionError::Closed)?;
		self.waker.wake_by_ref();
		let mut guard = CancelOnDrop { level: &level, waker: &self.waker, armed: true };
		let reply = reply_rx.recv_async();
		tokio::pin!(reply);
		let outcome = tokio::select! {
			r = &mut reply => Some(r),
			() = cancel.cancelled() => None,
		};
		let outcome = if let Some(r) = outcome {
			Some(r)
		} else {
			guard.raise(CancelLevel::TERM);
			if let Ok(r) = tokio::time::timeout(self.term_grace, &mut reply).await {
				Some(r)
			} else {
				guard.raise(CancelLevel::KILL);
				tokio::time::timeout(KILL_WAIT, &mut reply).await.ok()
			}
		};
		guard.armed = false;
		drop(guard);
		match outcome {
			Some(Ok(outcome)) => Ok(outcome),
			Some(Err(_)) => {
				self.close();
				Err(SessionError::Closed)
			},
			None => {
				self.close();
				Err(SessionError::Unresponsive)
			},
		}
	}

	/// Stop accepting jobs and let the driver task end (it drops the
	/// shell; externals still running are terminated by the spawner).
	fn close(&mut self) {
		if self.jobs.take().is_some() {
			self.waker.wake_by_ref();
		}
	}
}

impl Drop for Session {
	fn drop(&mut self) {
		self.close();
	}
}

/// Whether `path` is absolute for the engine (a Windows drive path, or a
/// `scheme://` URL path, too).
fn is_absolute(path: &[u8]) -> bool {
	path.first() == Some(&b'/')
		|| (cfg!(windows)
			&& path.get(1) == Some(&b':')
			&& path.first().is_some_and(u8::is_ascii_alphabetic))
		|| path.to_path().is_ok_and(pi_vfs::is_virtual_path)
}

/// Cancellation requested for one run: none, `TERM` or `KILL`.
#[derive(Default)]
struct CancelLevel(AtomicU8);

impl CancelLevel {
	const KILL: u8 = 2;
	const TERM: u8 = 1;

	fn get(&self) -> u8 {
		self.0.load(Ordering::Acquire)
	}
}

/// Escalates the run's cancel level and wakes the driver; stops the run with
/// `KILL` when the run future is dropped before the reply.
struct CancelOnDrop<'a> {
	level: &'a CancelLevel,
	waker: &'a Waker,
	armed: bool,
}

impl CancelOnDrop<'_> {
	fn raise(&self, level: u8) {
		self.level.0.fetch_max(level, Ordering::AcqRel);
		self.waker.wake_by_ref();
	}
}

impl Drop for CancelOnDrop<'_> {
	fn drop(&mut self) {
		if self.armed {
			self.raise(CancelLevel::KILL);
		}
	}
}

/// What the driver is asked to do.
enum Request {
	/// Run a command.
	Run(Job),
	/// Count the background jobs running an external.
	LiveJobs(flume::Sender<usize>),
}

/// One command for the driver.
struct Job {
	options: RunOptions,
	stdio:   RunStdio,
	cancel:  Arc<CancelLevel>,
	reply:   flume::Sender<RunOutcome>,
}

/// The driver task's state: the shell and everything it is stepped with.
struct Driver {
	shell:    Shell,
	store:    MemStore,
	host:     PiHost,
	bell:     Arc<Bell>,
	jobs:     flume::Receiver<Request>,
	children: Children,
	/// The host callouts in flight (`timeout`, `nohup`, `git`).
	tools:    ToolCalls,
	/// Updated at the end of each command.
	image:    LatestImage,
	/// The streams of ended commands kept open, each with the process
	/// substitutions it started that still ran when it ended
	/// ([`Driver::release_ended`]).
	held:     Vec<(HeldRun, Vec<Vpid>)>,
}

impl Driver {
	/// Run jobs until the session is closed; step background work between
	/// them.
	async fn serve(mut self) {
		loop {
			match self.jobs.try_recv() {
				Ok(Request::Run(job)) => self.run(job).await,
				Ok(Request::LiveJobs(reply)) => {
					let _ = reply.send(self.shell.live_external_jobs());
				},
				Err(flume::TryRecvError::Disconnected) => break,
				Err(flume::TryRecvError::Empty) => self.idle_turn().await,
			}
		}
	}

	/// One step of background work while no command runs, or a suspension
	/// when there is none to do (a new job's ring ends it).
	async fn idle_turn(&mut self) {
		self.poll_tools();
		let step = self.step(Budget::default());
		// Before any suspension: the step may have ended the last
		// substitution holding an earlier command's streams.
		self.release_ended();
		match step {
			Step::Done { run, status } => self.on_done(run, status),
			Step::Call { id, call } => self.on_call(id, call),
			Step::Yield => tokio::task::yield_now().await,
			Step::Blocked | Step::Paused => self.wait().await,
			Step::Idle => self.idle().await,
			Step::SuspendReady => {},
		}
	}

	/// Run one job to completion and send its outcome.
	async fn run(&mut self, job: Job) {
		let Job { options, stdio, cancel, reply } = job;
		let RunOptions { command, env, cwd, pipe_tap, reported_error, text_capture, events } =
			options;
		self.host.set_pipe_tap(pipe_tap);
		// A command owns its observer generation, even when successive
		// observers request identical event masks.
		self
			.shell
			.set_event_mask(events.as_ref().map_or(EventMask::NONE, |sink| sink.mask()));
		self.host.set_reported_error(reported_error);
		// The values the overlay hides, restored after the run.
		let saved: Vec<(BString, Option<Record>)> = env
			.iter()
			.map(|(name, _)| (name.clone(), self.store.record(Key::Var(name.as_bstr())).cloned()))
			.collect();
		// Submission only queues the script. Bind its exact identity before
		// any scheduler turn can announce an older background tool child.
		let run = self.shell.submit(Script {
			cwd,
			env,
			vproc: VprocSel::Root,
			..Script::command(command.as_bytes())
		});
		if let Some(sink) = &events {
			sink.run_submitted(run);
		}
		self.host.set_event_sink(events);
		self
			.host
			.streams()
			.install([stdio.stdin, stdio.stdout, stdio.stderr], text_capture);
		self.shell.reset_root_stdio(&mut self.host);
		// The substitutions an earlier command left running hold its
		// streams, not this command's.
		let earlier = self.shell.substitutions().to_vec();
		self.children.set_active(true);
		let mut applied = 0;
		let status = loop {
			let wanted = cancel.get();
			if wanted > applied {
				applied = wanted;
				let sig = if wanted >= CancelLevel::KILL {
					Signal::Kill
				} else {
					Signal::Term
				};
				self.shell.control().cancel(sig);
			}
			self.poll_tools();
			let step = self.step(Budget::default());
			self.release_ended();
			match step {
				Step::Done { run: done, status } if done == run => break status,
				Step::Done { run, status } => self.on_done(run, status),
				Step::Call { id, call } => self.on_call(id, call),
				Step::Yield => tokio::task::yield_now().await,
				Step::Blocked | Step::Paused => self.wait().await,
				Step::SuspendReady => {},
				// Unreachable while the run is queued (its `Done` is reported
				// before `Idle`); end the run rather than spin.
				Step::Idle => break 1,
			}
		};
		if applied > 0 {
			// A cancel that raced the run's natural end is still pending:
			// apply it now (it ends the background jobs this run started
			// too), not at the start of the next command.
			match self.step(Budget { max_ops: 1, max_ns: u64::MAX }) {
				Step::Done { run, status } => self.on_done(run, status),
				Step::Call { id, call } => self.on_call(id, call),
				_ => {},
			}
		}
		let exited = self.shell.ended_by_exit(run);
		self.settle().await;
		self.children.set_active(false);
		let holders: Vec<Vpid> = self
			.shell
			.exit_survivors()
			.into_iter()
			.filter(|v| !earlier.contains(v))
			.collect();
		let held = !holders.is_empty();
		if let Some(streams) = self.host.streams().end_run(held) {
			self.held.push((streams, holders));
		}
		self.host.set_pipe_tap(None);
		self.host.set_event_sink(None);
		// The root lets go of the command's streams: a `>(…)` reading them
		// (`exec > >(tee log)`) sees end of file.
		self.shell.reset_root_stdio(&mut self.host);
		self.shell.set_event_mask(EventMask::NONE);
		self.host.set_reported_error(None);
		self.restore_overlay(saved);
		self.image.publish(&self.store);
		let cwd = store_cwd(&self.store);
		// The caller may have stopped waiting (dropped future).
		let _ = reply.send(RunOutcome { status, cancelled: applied > 0, exited, cwd, held });
	}

	/// Close the streams of each ended command whose process
	/// substitutions, and those they started, have all ended.
	fn release_ended(&mut self) {
		if self.held.is_empty() {
			return;
		}
		let shell = &self.shell;
		let (ended, running): (Vec<_>, Vec<_>) = std::mem::take(&mut self.held)
			.into_iter()
			.partition(|(_, holders)| !holders.iter().any(|&v| shell.substitution_from(v)));
		self.held = running;
		for (run, _) in ended {
			self.host.streams().release(run);
		}
	}

	/// Let the background work a command started reach its first wait (an
	/// external spawned, a pipe read) before the command reports, so the
	/// caller's next look at the session (`live_external_jobs`) sees what the
	/// command left running. Bounded: a busy background loop never waits.
	async fn settle(&mut self) {
		for _ in 0..SETTLE_STEPS {
			self.poll_tools();
			match self.step(Budget::default()) {
				Step::Done { run, status } => self.on_done(run, status),
				Step::Call { id, call } => self.on_call(id, call),
				Step::Yield => tokio::task::yield_now().await,
				Step::SuspendReady => {},
				Step::Blocked | Step::Paused | Step::Idle => break,
			}
		}
	}

	/// Put back the variables a run's env overlay replaced, newest first so
	/// a name given twice ends at its original value.
	fn restore_overlay(&mut self, saved: Vec<(BString, Option<Record>)>) {
		for (name, record) in saved.into_iter().rev() {
			let key = Key::Var(name.as_bstr());
			match record {
				// A variable record always fits a variable key.
				Some(record) => drop(self.store.put_out_of_band(key, record)),
				None => self.store.del_out_of_band(key),
			}
		}
	}

	/// A script other than the current command finished: a subshell of a
	/// host callout ([`ToolCalls::on_done`]); nothing else submits scripts.
	fn on_done(&mut self, run: RunId, status: i32) {
		let signal = self.shell.exec_signal(run);
		let refusal = self.shell.exec_refusal(run);
		self.tools.on_done(run, status, signal, refusal);
	}

	/// Start a host callout ([`crate::bash::Resolved::Tool`]).
	fn on_call(&mut self, id: CallId, call: ToolCall) {
		let mut cx = Cx { host: &mut self.host, store: &mut self.store };
		self.tools.on_call(&mut self.shell, &mut cx, id, call);
	}

	/// Let the host callouts in flight make progress (answering the calls
	/// that finished).
	fn poll_tools(&mut self) {
		let mut cx = Cx { host: &mut self.host, store: &mut self.store };
		self.tools.poll(&mut self.shell, &mut cx);
	}

	fn step(&mut self, budget: Budget) -> Step {
		self
			.shell
			.step(&mut Cx { host: &mut self.host, store: &mut self.store }, budget)
	}

	/// Suspend until the shell may make progress, a job or cancel request
	/// rings the bell, or a host callout's deadline comes.
	///
	/// The future owns what it waits on, so it does not hold the driver.
	fn wait(&self) -> impl Future<Output = ()> + Send + use<> {
		let ctl = self.shell.control();
		let bell = Arc::clone(&self.bell);
		let now = crate::bash::Host::now_ns(&self.host);
		let limit = self
			.tools
			.next_deadline()
			.map_or(MAX_PARK, |at| Duration::from_nanos(at.saturating_sub(now)).min(MAX_PARK));
		async move {
			tokio::select! {
				biased;
				() = poll_fn(|cx| ctl.poll_runnable(cx)) => {},
				() = bell.0.notified() => {},
				() = tokio::time::sleep(limit) => {},
			}
		}
	}

	/// Suspend while there is nothing to run: until a job, a tool worker
	/// or the loss-bound timeout rings.
	fn idle(&self) -> impl Future<Output = ()> + Send + use<> {
		let bell = Arc::clone(&self.bell);
		async move {
			tokio::select! {
				biased;
				() = bell.0.notified() => {},
				() = tokio::time::sleep(MAX_PARK) => {},
			}
		}
	}
}

/// Test support: seeing a session's shell wait on output that a writer thread
/// holds (fd 2 a full pipe on the writer-thread route).
#[cfg(all(test, target_os = "linux"))]
pub(crate) mod held {
	use std::{
		collections::HashSet,
		time::{Duration, Instant},
	};

	/// The tids of this process's writer threads (`obash-write`, the
	/// `BlockingWriter` of [`crate::sys::StdFile`]).
	pub(crate) fn writer_threads() -> HashSet<u32> {
		std::fs::read_dir("/proc/self/task")
			.expect("this process's threads in /proc/self/task")
			.flatten()
			.filter(|task| {
				std::fs::read_to_string(task.path().join("comm"))
					.is_ok_and(|comm| comm.trim() == "obash-write")
			})
			.filter_map(|task| task.file_name().to_str()?.parse().ok())
			.collect()
	}

	/// How many processes have this one as their parent, running or not yet
	/// reaped. A scan that saw no process would count no child, so it must
	/// see this process itself.
	fn children() -> usize {
		let me = std::process::id();
		let (mut seen_me, mut children) = (false, 0);
		for entry in std::fs::read_dir("/proc").expect("/proc").flatten() {
			let Some(pid) = entry
				.file_name()
				.to_str()
				.and_then(|name| name.parse::<u32>().ok())
			else {
				continue;
			};
			let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
				continue;
			};
			// `pid (comm) state ppid ...`; the name may hold spaces.
			let ppid = stat
				.rsplit_once(") ")
				.and_then(|(_, rest)| rest.split(' ').nth(1)?.parse::<u32>().ok());
			seen_me |= pid == me;
			children += usize::from(ppid == Some(me));
		}
		assert!(seen_me, "/proc does not list this process ({me}), so it would show no child");
		children
	}

	/// Each worker's park/unpark count, odd while the worker is parked with
	/// no task to run (`RuntimeMetrics::worker_park_unpark_count`).
	fn parks(runtime: &tokio::runtime::Handle) -> Vec<u64> {
		let metrics = runtime.metrics();
		(0..metrics.num_workers())
			.map(|worker| metrics.worker_park_unpark_count(worker))
			.collect()
	}

	/// `look`'s result once the shell is seen waiting on output a writer
	/// thread holds: a writer thread not in `before` took that output, no
	/// child process runs, and every worker of `runtime` (the session's
	/// driver runs there) is parked before and after `look`, with no park or
	/// unpark between. A shell that waits for that output to be out sleeps
	/// there until the output is out; a shell that does not wait has by then
	/// run what comes next. `Err` names what was seen last once 10 s pass.
	pub(crate) fn once_the_shell_waits<T>(
		runtime: &tokio::runtime::Handle,
		before: &HashSet<u32>,
		mut look: impl FnMut() -> T,
	) -> Result<T, String> {
		let deadline = Instant::now() + Duration::from_secs(10);
		loop {
			let parked = parks(runtime);
			let writer = !writer_threads().is_subset(before);
			let children = children();
			if parked.iter().all(|n| !n.is_multiple_of(2)) && writer && children == 0 {
				let seen = look();
				if parks(runtime) == parked {
					return Ok(seen);
				}
			}
			if Instant::now() >= deadline {
				return Err(format!(
					"the shell was never seen waiting on its held output within 10 s: worker \
					 park/unpark counts {parked:?} (odd: parked), a new writer thread: {writer}, \
					 {children} child processes"
				));
			}
			std::thread::sleep(Duration::from_millis(1));
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{io, io::Read, os::unix::ffi::OsStrExt, time::Instant};

	use super::*;
	use crate::sys::StdFs;

	fn session() -> Session {
		let env = std::env::vars_os()
			.map(|(k, v)| (BString::from(k.as_bytes()), BString::from(v.as_bytes())))
			.collect();
		let cwd = std::env::current_dir().unwrap();
		Session::new(SessionConfig {
			env,
			cwd: BString::from(cwd.as_os_str().as_bytes()),
			fs: Box::new(StdFs::default()),
			vfs: None,
			runtime: tokio::runtime::Handle::current(),
			output_decoding: None,
			term_grace: crate::host::TERM_GRACE,
		})
		.unwrap()
	}

	/// A command's outcome and its stdout and stderr, read through pipes on
	/// threads (the pipes are drained while the command runs).
	struct Captured {
		outcome: RunOutcome,
		stdout:  String,
		stderr:  String,
	}

	async fn capture(session: &mut Session, options: RunOptions) -> Captured {
		let (out_r, out_w) = io::pipe().unwrap();
		let (err_r, err_w) = io::pipe().unwrap();
		let drain = |mut r: io::PipeReader| {
			std::thread::spawn(move || {
				let mut s = String::new();
				r.read_to_string(&mut s).unwrap();
				s
			})
		};
		let (out, err) = (drain(out_r), drain(err_r));
		let stdout = std::fs::File::from(std::os::fd::OwnedFd::from(out_w));
		let stderr = if options.text_capture {
			drop(err_w);
			stdout.try_clone().unwrap()
		} else {
			std::fs::File::from(std::os::fd::OwnedFd::from(err_w))
		};
		let stdio = RunStdio {
			stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
			stdout: Some(stdout),
			stderr: Some(stderr),
		};
		let outcome = session
			.run_with(options, stdio, CancellationToken::new())
			.await
			.unwrap();
		Captured { outcome, stdout: out.join().unwrap(), stderr: err.join().unwrap() }
	}

	async fn sh(session: &mut Session, command: &str) -> Captured {
		capture(session, RunOptions::new(command)).await
	}

	/// Exercise tracing through the real engine, native tools, spawner and
	/// capture pipes, never `FakeHost`'s synthetic command implementations.
	async fn trace_capture(
		session: &mut Session,
		command: &str,
	) -> (Captured, Arc<crate::bash::trace::RunTrace>) {
		let trace = Arc::new(crate::bash::trace::RunTrace::new(command));
		let options =
			RunOptions { events: Some(trace.clone()), text_capture: true, ..RunOptions::new(command) };
		let captured = capture(session, options).await;
		(captured, trace)
	}

	fn trace_output(snapshot: &crate::bash::trace::Snapshot) -> String {
		let mut out = String::new();
		for entry in &snapshot.history {
			if let crate::bash::trace::history::HistoryData::Output { text, .. } = &entry.data {
				out.push_str(&String::from_utf8_lossy(text));
			}
		}
		out
	}

	fn producer_source<'a>(
		snapshot: &'a crate::bash::trace::Snapshot,
		event: &crate::bash::trace::history::HistoryEvent,
	) -> &'a [u8] {
		let unit = &snapshot.units[event.u.expect("attributed unit") as usize];
		let node = &unit.nodes[event.n.expect("attributed node") as usize];
		let source = match unit.at {
			Some(at) => &snapshot.script[at as usize..],
			None => unit.source.as_ref().expect("unlocated source").as_slice(),
		};
		&source[node.lo as usize..node.hi as usize]
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_descriptor_wrappers_keep_thin_handles_and_shared_identity() {
		use crate::bash::{CmdTag, FdFlags, FdRef, Host, RunId, StdFd, Vpid};
		let mut host = PiHost::new(
			Box::new(StdFs::default()),
			tokio::runtime::Handle::current(),
			crate::host::TERM_GRACE,
		);
		host.set_event_sink(Some(Arc::new(crate::bash::trace::RunTrace::new(""))));
		let (_reader, writer) = io::pipe().unwrap();
		host.streams().install(
			[None, Some(std::fs::File::from(std::os::fd::OwnedFd::from(writer))), None],
			false,
		);
		let base = FdRef::from_file(Host::stdio(&mut host, StdFd::Stdout).unwrap());
		let first = CmdTag { run: RunId(1), vpid: Vpid(1), seq: 1 };
		let tagged = base.clone().with_tag(first);
		let retagged = tagged.clone().with_tag(CmdTag { seq: 2, ..first });
		assert!(base.same(&tagged) && tagged.same(&retagged));
		assert!(base.downgrade().is(&retagged) && tagged.downgrade().is(&base));
		base.set_flags(FdFlags::CLOEXEC);
		assert_eq!(tagged.flags(), FdFlags::CLOEXEC);
		retagged.set_flags(FdFlags::FLOCK);
		assert_eq!(base.flags(), FdFlags::FLOCK);
		assert_eq!(tagged.flags(), FdFlags::FLOCK);
		assert_eq!(base.output_key(), retagged.output_key());
		assert!(
			!tagged.dup().unwrap().same(&base),
			"dup retains its preexisting new-object identity"
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_visible_output_covers_builtin_native_external_and_loop_iterations() {
		use crate::bash::trace::history::HistoryData;
		let mut session = session();
		let script = "for i in one two three; do echo \"$i\"; done; printf 'builtin\\n'; \
		              /usr/bin/printf 'external\\n'; seq 1 2";
		let (captured, trace) = trace_capture(&mut session, script).await;
		assert_eq!(captured.stdout, "one\ntwo\nthree\nbuiltin\nexternal\n1\n2\n");
		let snapshot = trace.snapshot();
		assert_eq!(trace_output(&snapshot), captured.stdout);
		let mut loop_executions = std::collections::HashSet::new();
		for event in &snapshot.history {
			if let HistoryData::Output { .. } = event.data {
				let source = producer_source(&snapshot, event);
				if source == b"echo \"$i\"" {
					loop_executions.insert(event.command.expect("loop execution identity"));
				}
			}
		}
		assert_eq!(loop_executions.len(), 3);
		let owned_json = serde_json::to_value(&snapshot).unwrap();
		let borrowed_json: serde_json::Value = serde_json::from_str(&trace.snapshot_json()).unwrap();
		assert_eq!(
			borrowed_json, owned_json,
			"zero-copy polling preserves the owned snapshot contract"
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_pipeline_redirection_substitution_and_merged_stderr_are_real_visible_output() {
		use crate::bash::trace::history::HistoryData;
		let mut session = session();
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("hidden");
		let script = format!(
			"echo pipeline | /bin/cat; /bin/sh -c 'printf out; printf err >&2' 2>&1; /usr/bin/printf \
			 hidden >'{}'; value=$(/usr/bin/printf substitution); echo \"$value\"",
			path.display()
		);
		let (captured, trace) = trace_capture(&mut session, &script).await;
		assert_eq!(captured.stdout, "pipeline\nouterrsubstitution\n");
		assert_eq!(captured.stderr, "");
		assert_eq!(std::fs::read_to_string(path).unwrap(), "hidden");
		let snapshot = trace.snapshot();
		assert_eq!(trace_output(&snapshot), captured.stdout);
		for event in &snapshot.history {
			if let HistoryData::Output { fd, .. } = &event.data {
				assert_eq!(*fd, 1, "stderr merged to stdout names the final capture descriptor");
				let source = producer_source(&snapshot, event);
				assert!(
					source == b"/bin/cat"
						|| source.starts_with(b"/bin/sh -c")
						|| source == b"echo \"$value\"",
					"intermediate pipe/file/substitution bytes must not be terminal output: {:?}",
					String::from_utf8_lossy(source)
				);
			}
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_pipeline_and_background_children_keep_their_real_engine_tags() {
		use crate::bash::trace::history::HistoryData;
		let mut session = session();
		let script = "echo start; printf 'one\\ntwo\\n' | tr a-z A-Z; (echo background) & wait";
		let (captured, trace) = trace_capture(&mut session, script).await;
		assert_eq!(captured.stdout, "start\nONE\nTWO\nbackground\n");
		let snapshot = trace.snapshot();
		assert_eq!(
			trace_output(&snapshot),
			captured.stdout,
			"child run queues are empty, not absent output"
		);
		let root = snapshot
			.history
			.iter()
			.find_map(|entry| match &entry.data {
				HistoryData::Output { text, .. } if text.as_slice() == b"start\n" => entry.command,
				_ => None,
			})
			.expect("root execution tag");
		let mut children = std::collections::HashSet::new();
		for entry in &snapshot.history {
			if let HistoryData::Output { text, .. } = &entry.data {
				let command = entry.command.expect("actual writer execution tag");
				producer_source(&snapshot, entry);
				if text.as_slice() != b"start\n" {
					assert_ne!(
						command.vpid, root.vpid,
						"pipeline/background output comes from child vprocs"
					);
					children.insert(command.vpid);
				}
			}
		}
		assert_eq!(children.len(), 2);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_separate_stderr_capture_keeps_descriptor_two() {
		let mut session = session();
		let script = "/bin/sh -c 'printf external >&2'; printf builtin >&2";
		let trace = Arc::new(crate::bash::trace::RunTrace::new(script));
		let options = RunOptions { events: Some(trace.clone()), ..RunOptions::new(script) };
		let captured = capture(&mut session, options).await;
		assert_eq!(captured.stdout, "");
		assert_eq!(captured.stderr, "externalbuiltin");
		let snapshot = trace.snapshot();
		assert_eq!(trace_output(&snapshot), captured.stderr);
		assert!(
			snapshot
				.history
				.iter()
				.filter_map(|entry| match entry.data {
					crate::bash::trace::history::HistoryData::Output { fd, .. } => Some(fd),
					_ => None,
				})
				.all(|fd| fd == 2)
		);
	}

	/// Output written while no command tags the fds (an arithmetic
	/// command's diagnostic, an xtrace line of one) is visible output too:
	/// the trace holds every byte the capture got.
	#[tokio::test(flavor = "multi_thread")]
	async fn trace_output_written_outside_a_simple_command_is_visible_output() {
		let mut session = session();
		let (captured, trace) =
			trace_capture(&mut session, "(( 1/0 )); set -x; (( 2 )); set +x; echo after").await;
		assert!(captured.stdout.contains("division by 0"), "{:?}", captured.stdout);
		assert!(captured.stdout.contains("+ ((  2  ))"), "{:?}", captured.stdout);
		assert_eq!(trace_output(&trace.snapshot()), captured.stdout);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_shared_capture_preserves_external_stdout_stderr_interleaving() {
		let mut session = session();
		let script =
			"/bin/sh -c 'printf a; printf b >&2; printf c; printf d >&2'; printf builtin >&2";
		let (captured, trace) = trace_capture(&mut session, script).await;
		assert_eq!(captured.stdout, "abcdbuiltin");
		assert_eq!(captured.stderr, "");
		let snapshot = trace.snapshot();
		assert_eq!(trace_output(&snapshot), captured.stdout);
		for entry in &snapshot.history {
			if let crate::bash::trace::history::HistoryData::Output { fd, .. } = entry.data {
				assert_eq!(fd, 1, "one merged capture keeps one stream identity");
				producer_source(&snapshot, entry);
			}
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_background_interleaving_preserves_output_order_and_producer() {
		use crate::bash::trace::history::HistoryData;
		let mut session = session();
		let script = "{ /usr/bin/printf a1; /bin/sleep 0.03; /usr/bin/printf a2; } & { \
		              /usr/bin/printf b1; /bin/sleep 0.01; /usr/bin/printf b2; } & wait";
		let (captured, trace) = trace_capture(&mut session, script).await;
		let snapshot = trace.snapshot();
		assert_eq!(trace_output(&snapshot), captured.stdout);
		for text in ["a1", "a2", "b1", "b2"] {
			assert!(captured.stdout.contains(text));
		}
		for event in &snapshot.history {
			if let HistoryData::Output { text, .. } = &event.data {
				let source = String::from_utf8_lossy(producer_source(&snapshot, event));
				assert_eq!(source, format!("/usr/bin/printf {}", String::from_utf8_lossy(text)));
			}
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_unit_bytes_include_heredoc_but_not_the_next_command() {
		use crate::bash::syntax::{Features, parse_all};

		let mut session = session();
		let script = "cat <<'EOF'\npayload\nEOF\necho next";
		let (captured, trace) = trace_capture(&mut session, script).await;
		assert_eq!(captured.stdout, "payload\nnext\n");
		let snapshot = trace.snapshot();
		let unit = &snapshot.units[0];
		let start = unit.at.unwrap() as usize;
		let source = &snapshot.script[start..start + unit.bytes as usize];
		assert_eq!(source, b"cat <<'EOF'\npayload\nEOF");
		assert_eq!(parse_all(source, Features::NONE).unwrap().commands.len(), 1);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_assignments_scopes_status_and_replay_order_are_retained() {
		use crate::bash::{event::AssignScope, trace::history::HistoryData};
		let mut session = session();
		let script = "GLOBAL=outer; f() { local LOCAL=inner; ENV=value /usr/bin/printf '%s' \
		              \"$LOCAL\"; }; f; false";
		let (captured, trace) = trace_capture(&mut session, script).await;
		assert_eq!(captured.stdout, "inner");
		let snapshot = trace.snapshot();
		assert_eq!(snapshot.status, Some(1));
		assert!(matches!(snapshot.history.first().unwrap().data, HistoryData::RunStart));
		assert!(matches!(snapshot.history.last().unwrap().data, HistoryData::RunEnd { status: 1 }));
		assert!(
			snapshot
				.history
				.windows(2)
				.all(|pair| pair[0].seq < pair[1].seq)
		);
		for (name, value, expected_scope) in [
			("GLOBAL", "outer", AssignScope::Global),
			("LOCAL", "inner", AssignScope::Local),
			("ENV", "value", AssignScope::Env),
		] {
			assert!(
				snapshot.history.iter().any(|entry| matches!(&entry.data,
				HistoryData::Assign { name: n, value: v, scope, full_len }
					if n.as_slice() == name.as_bytes() && v.as_slice() == value.as_bytes()
						&& *scope == expected_scope && *full_len == value.len())),
				"{name} assignment scope/value"
			);
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_quiet_external_output_advances_revision_before_command_end() {
		let mut session = session();
		let gates = tempfile::tempdir().unwrap();
		let (mut next, mut end) =
			(crate::testkit::child::Gate::new(), crate::testkit::child::Gate::new());
		next.link(&gates.path().join("next"));
		end.link(&gates.path().join("end"));
		// The second wait is the same as `AWAIT_GATE`, on fd 4.
		let script = format!(
			"/bin/sh -c 'printf first; {}; printf second; while read -r _; do :; done <&4' 3< {} 4< \
			 {}",
			crate::testkit::child::AWAIT_GATE,
			gates.path().join("next").display(),
			gates.path().join("end").display()
		);
		let trace = Arc::new(crate::bash::trace::RunTrace::new(script.as_str()));
		let options = RunOptions {
			events: Some(trace.clone()),
			text_capture: true,
			..RunOptions::new(script.as_str())
		};
		let probe = async {
			let first = loop {
				if trace_output(&trace.snapshot()) == "first" {
					let revision = trace.version();
					next.open();
					break revision;
				}
				tokio::task::yield_now().await;
			};
			loop {
				let snapshot = trace.snapshot();
				if trace_output(&snapshot) == "firstsecond" {
					assert!(trace.version() > first, "coalescing changes the poll revision");
					assert!(snapshot.status.is_none(), "output is visible before CmdEnd/RunEnd");
					end.open();
					break;
				}
				tokio::task::yield_now().await;
			}
		};
		let (captured, ()) = tokio::join!(capture(&mut session, options), probe);
		assert_eq!(captured.stdout, "firstsecond");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_assignment_retains_full_value_length_when_value_is_cut() {
		use crate::bash::trace::history::HistoryData;
		let mut session = session();
		let value = "a".repeat(400);
		let script = format!("LONG={value}");
		let (_, trace) = trace_capture(&mut session, &script).await;
		assert!(
			trace
				.snapshot()
				.history
				.iter()
				.any(|entry| matches!(&entry.data,
			HistoryData::Assign { name, value, full_len, .. }
				if name.as_slice() == b"LONG" && value.len() == 256 && *full_len == 400))
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_builtin_setters_report_actual_values_scopes_vpids_and_source() {
		use crate::bash::{event::AssignScope, trace::history::HistoryData};
		let mut session = session();
		let script = "x=first\nx=second\nread -r choice <<< deploy\nfor item in build test; do :; \
		              done\nf() { local x=local; read x <<< changed; }; f\nexport \
		              exported=value\ndeclare -i number=1\n((number+=2))\nlet number++\nprintf -v \
		              formatted '%s' rendered\n";
		let (captured, trace) = trace_capture(&mut session, script).await;
		assert_eq!(captured.outcome.status, 0);
		let snapshot = trace.snapshot();
		for (name, value, scope, source) in [
			("x", "first", AssignScope::Global, "x=first"),
			("x", "second", AssignScope::Global, "x=second"),
			("choice", "deploy", AssignScope::Global, "read -r choice"),
			("item", "build", AssignScope::Global, "for item"),
			("item", "test", AssignScope::Global, "for item"),
			("x", "local", AssignScope::Local, "local x=local"),
			("x", "changed", AssignScope::Local, "read x"),
			("exported", "value", AssignScope::Global, "export exported=value"),
			("number", "3", AssignScope::Global, "((number+=2))"),
			("number", "4", AssignScope::Global, "let number++"),
			("formatted", "rendered", AssignScope::Global, "printf -v formatted"),
		] {
			let entry = snapshot
				.history
				.iter()
				.find(|entry| {
					matches!(&entry.data,
				HistoryData::Assign { name: n, value: v, scope: actual_scope, full_len }
				if n.as_slice() == name.as_bytes() && v.as_slice() == value.as_bytes()
					&& *actual_scope == scope && *full_len == value.len())
				})
				.unwrap_or_else(|| panic!("missing setter {name}={value} with scope {scope:?}"));
			assert!(entry.vpid.is_some(), "all real setter events carry their vproc");
			assert!(
				String::from_utf8_lossy(producer_source(&snapshot, entry)).starts_with(source),
				"setter source for {name}={value}"
			);
		}
		let (_, rejected) =
			trace_capture(&mut session, "readonly locked=initial; read locked <<< rejected").await;
		assert!(
			!rejected
				.snapshot()
				.history
				.iter()
				.any(|entry| matches!(&entry.data,
			HistoryData::Assign { value, .. } if value.as_slice() == b"rejected"))
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_raw_file_capture_preserves_bytes_and_finalizes_utf8_only_at_eof() {
		use std::io::Seek;
		let mut session = session();
		for (command, expected) in
			[("/usr/bin/printf '\\377'", b"\xff".as_slice()), ("printf '\\303'", b"\xc3".as_slice())]
		{
			let mut output = tempfile::tempfile().unwrap();
			let trace = Arc::new(crate::bash::trace::RunTrace::new(command));
			let options = RunOptions { events: Some(trace.clone()), ..RunOptions::new(command) };
			let streams =
				RunStdio { stdout: Some(output.try_clone().unwrap()), ..RunStdio::default() };
			let result = session
				.run_with(options, streams, CancellationToken::new())
				.await
				.unwrap();
			assert_eq!(result.status, 0);
			output.rewind().unwrap();
			let mut bytes = Vec::new();
			output.read_to_end(&mut bytes).unwrap();
			assert_eq!(bytes, expected, "tracing cannot transcode raw caller files");
			let snapshot = trace.snapshot();
			assert_eq!(trace_output(&snapshot), "\u{fffd}");
			assert!(snapshot.history.iter().any(|entry| matches!(
				entry.data,
				crate::bash::trace::history::HistoryData::Output { .. }
			) && entry.u.is_some()
				&& entry.n.is_some()));
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_extra_output_alias_keeps_one_real_kernel_stream() {
		let mut session = session();
		let script = "exec 3>&1; /bin/sh -c 'printf a; printf b >&3; printf c'";
		let (captured, trace) = trace_capture(&mut session, script).await;
		assert_eq!(captured.stdout, "abc");
		let snapshot = trace.snapshot();
		assert_eq!(trace_output(&snapshot), captured.stdout);
		for entry in &snapshot.history {
			if let crate::bash::trace::history::HistoryData::Output { .. } = entry.data {
				assert_eq!(
					producer_source(&snapshot, entry),
					b"/bin/sh -c 'printf a; printf b >&3; printf c'"
				);
			}
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_utf8_continues_across_commands_with_exact_fragment_provenance() {
		use crate::bash::trace::history::HistoryData;
		let mut session = session();
		let (captured, trace) = trace_capture(&mut session, "printf '\\303'; printf '\\251'").await;
		assert_eq!(captured.stdout, "é");
		let snapshot = trace.snapshot();
		assert_eq!(trace_output(&snapshot), captured.stdout);
		let mixed = snapshot
			.history
			.iter()
			.find_map(|entry| match &entry.data {
				HistoryData::Output { text, contributors, .. } if text.as_slice() == "é".as_bytes() => {
					Some((entry, contributors))
				},
				_ => None,
			})
			.expect("one decoded scalar");
		assert!(
			mixed.0.u.is_none() && mixed.0.n.is_none() && mixed.0.command.is_none(),
			"a scalar made by two commands has no invented primary producer"
		);
		assert_eq!(
			mixed
				.1
				.iter()
				.flat_map(|entry| entry.bytes.iter().copied())
				.collect::<Vec<_>>(),
			"é".as_bytes()
		);
		assert_eq!(mixed.1.len(), 2);
		assert!(
			mixed
				.1
				.iter()
				.all(|entry| entry.u.is_some() && entry.n.is_some() && entry.command.is_some())
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_sibling_deferred_functions_keep_each_materialized_setter_span() {
		use crate::bash::trace::history::HistoryData;
		let mut session = session();
		let script = "outer() { a() { local x=first; }; b() { local x=second; read x <<< third; }; \
		              a; b; a; }; outer";
		let (_, trace) = trace_capture(&mut session, script).await;
		let snapshot = trace.snapshot();
		for (value, source) in
			[("first", "local x=first"), ("second", "local x=second"), ("third", "read x <<< third")]
		{
			for entry in snapshot.history.iter().filter(|entry| matches!(&entry.data,
				HistoryData::Assign { name, value: actual, .. } if name.as_slice() == b"x" && actual.as_slice() == value.as_bytes()))
			{
				assert_eq!(producer_source(&snapshot, entry), source.as_bytes(), "materializing a sibling must not restore empty word placeholders");
			}
			assert!(snapshot.history.iter().any(|entry| matches!(&entry.data,
				HistoryData::Assign { name, value: actual, .. } if name.as_slice() == b"x" && actual.as_slice() == value.as_bytes())));
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_cached_function_units_are_announced_lazily_to_each_run() {
		let mut session = session();
		let (_, first) = trace_capture(&mut session, "f() { echo hello; }; f").await;
		assert_eq!(trace_output(&first.snapshot()), "hello\n");
		let (captured, trace) = trace_capture(&mut session, "f").await;
		assert_eq!(captured.stdout, "hello\n");
		let snapshot = trace.snapshot();
		assert_eq!(trace_output(&snapshot), captured.stdout);
		for entry in &snapshot.history {
			if let crate::bash::trace::history::HistoryData::Output { .. } = entry.data {
				assert_eq!(producer_source(&snapshot, entry), b"echo hello");
			}
		}
		assert!(snapshot.units.iter().any(|unit| {
			unit.at.is_none()
				&& unit
					.source
					.as_ref()
					.is_some_and(|source| source.as_slice().contains_str("echo hello"))
		}));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_tool_child_run_keeps_root_epoch_status_and_producer() {
		use crate::bash::trace::history::HistoryData;
		let mut session = session();
		let gates = tempfile::tempdir().unwrap();
		let mut gate = crate::testkit::child::Gate::new();
		gate.link(&gates.path().join("finish"));
		let script = format!(
			"timeout 1 /usr/bin/printf hi; /bin/sh -c '{}' 3< {}; /usr/bin/false",
			crate::testkit::child::AWAIT_GATE,
			gates.path().join("finish").display()
		);
		let trace = Arc::new(crate::bash::trace::RunTrace::new(script.as_str()));
		let options = RunOptions {
			events: Some(trace.clone()),
			text_capture: true,
			..RunOptions::new(script.as_str())
		};
		let probe = async {
			loop {
				let snapshot = trace.snapshot();
				if snapshot
					.history
					.iter()
					.any(|entry| matches!(entry.data, HistoryData::RunEnd { status: 0 }))
				{
					assert_eq!(snapshot.status, None, "a tool child cannot complete the root snapshot");
					assert_eq!(trace_output(&snapshot), "hi");
					gate.open();
					break;
				}
				tokio::task::yield_now().await;
			}
		};
		let (captured, ()) = tokio::join!(capture(&mut session, options), probe);
		assert_eq!(captured.outcome.status, 1);
		let snapshot = trace.snapshot();
		assert_eq!(snapshot.status, Some(1));
		assert_eq!(snapshot.history.first().unwrap().t_ns, 0);
		assert_eq!(trace_output(&snapshot), captured.stdout);
		for entry in &snapshot.history {
			if let HistoryData::Output { .. } = entry.data {
				let unit = &snapshot.units[entry.u.expect("tool output has an actual unit") as usize];
				let producer =
					&unit.nodes[entry.n.expect("tool output has an actual command") as usize];
				assert_eq!(producer.argv, ["/usr/bin/printf", "hi"]);
			}
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_old_background_tool_runs_cannot_claim_the_next_root() {
		let mut session = session();
		let (_, old) =
			trace_capture(&mut session, "{ /bin/sleep 0.05; timeout 1 /usr/bin/printf old; } &").await;
		let old_version = old.version();
		let (captured, next) = trace_capture(&mut session, "/bin/sleep 0.15; echo next").await;
		assert_eq!(captured.stdout, "next\n");
		assert_eq!(trace_output(&next.snapshot()), captured.stdout);
		assert_eq!(old.version(), old_version);
		assert!(
			!next
				.snapshot()
				.history
				.iter()
				.any(|entry| matches!(&entry.data,
			crate::bash::trace::history::HistoryData::CmdExpanded { argv, .. }
				if argv.iter().any(|arg| arg.as_slice() == b"old")))
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_utf8_split_writes_and_merged_stderr_preserve_text() {
		let mut session = session();
		// Separate real external writes split both an accented character and
		// an emoji across kernel writes; sleep encourages relay/pump boundaries.
		let script = "/bin/sh -c 'printf \"\\303\"; sleep 0.02; printf \"\\251\"; printf \"\\360\" \
		              >&2; sleep 0.02; printf \"\\237\\230\\200\" >&2' 2>&1";
		let (captured, trace) = trace_capture(&mut session, script).await;
		assert_eq!(captured.stdout, "é😀");
		let snapshot = trace.snapshot();
		assert_eq!(trace_output(&snapshot), captured.stdout);
		for entry in snapshot.history {
			if let crate::bash::trace::history::HistoryData::Output { text, .. } = entry.data {
				assert!(std::str::from_utf8(&text).is_ok());
				assert!(entry.u.is_some() && entry.n.is_some());
			}
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_history_and_output_caps_are_explicit_and_bounded() {
		use crate::bash::trace::history::{
			HISTORY_BYTES, HISTORY_EVENTS, HISTORY_OUTPUT_BYTES, HistoryData,
		};
		let mut session = session();
		let (captured, trace) = trace_capture(
			&mut session,
			"for ((i=0; i<4500; i++)); do :; done; /usr/bin/head -c 2200000 /dev/zero | /usr/bin/tr \
			 '\\000' x",
		)
		.await;
		assert_eq!(captured.outcome.status, 0);
		assert_eq!(captured.stdout.len(), 2_200_000);
		let snapshot = trace.snapshot();
		assert!(snapshot.history_truncated);
		assert!(snapshot.history.len() <= HISTORY_EVENTS);
		let bytes: usize = snapshot
			.history
			.iter()
			.map(|entry| match &entry.data {
				HistoryData::Output { text, .. } => text.len(),
				_ => 0,
			})
			.sum();
		assert!(bytes <= HISTORY_OUTPUT_BYTES);
		assert!(trace.snapshot_json().len() <= HISTORY_BYTES * 2);
		assert!(matches!(snapshot.history.last().unwrap().data, HistoryData::RunEnd { status: 0 }));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_cancelled_run_detaches_its_observer_before_the_next_call() {
		let mut session = session();
		let trace = Arc::new(crate::bash::trace::RunTrace::new("/bin/sleep 30"));
		let cancel = CancellationToken::new();
		let trigger = cancel.clone();
		let children = session.children();
		let cancellation = async move {
			while children.pids().is_empty() {
				tokio::task::yield_now().await;
			}
			trigger.cancel();
		};
		let options = RunOptions { events: Some(trace.clone()), ..RunOptions::new("/bin/sleep 30") };
		let (outcome, ()) =
			tokio::join!(session.run_with(options, RunStdio::default(), cancel), cancellation,);
		assert!(outcome.unwrap().cancelled);
		let old_version = trace.version();
		let (captured, next) = trace_capture(&mut session, "echo after-cancel").await;
		assert_eq!(captured.stdout, "after-cancel\n");
		assert_eq!(trace_output(&next.snapshot()), captured.stdout);
		assert_eq!(trace.version(), old_version);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trace_old_background_work_never_enters_a_successive_run() {
		let mut session = session();
		let (_, first) = trace_capture(&mut session, "(/bin/sleep 0.1; /usr/bin/printf old) &").await;
		let first_version = first.version();
		let (captured, second) = trace_capture(&mut session, "/bin/sleep 0.2; echo new").await;
		assert_eq!(captured.stdout, "new\n");
		assert_eq!(trace_output(&second.snapshot()), "new\n");
		assert_eq!(first.version(), first_version, "closed run streams stop observing late output");
		let snapshot = second.snapshot();
		let runs: std::collections::HashSet<_> = snapshot
			.history
			.iter()
			.filter_map(|entry| entry.command.map(|command| command.run))
			.collect();
		assert_eq!(runs.len(), 1, "events from the old background run are filtered too");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn echo_is_captured_through_a_pipe() {
		let mut s = session();
		let c = sh(&mut s, "echo hi").await;
		assert_eq!((c.outcome.status, c.stdout.as_str()), (0, "hi\n"));
		assert!(!c.outcome.cancelled);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn exec_standard_redirections_end_at_run_boundary() {
		let mut s = session();
		let first = sh(&mut s, "exec >/dev/null; echo hidden").await;
		assert_eq!(first.stdout, "");
		assert_eq!(sh(&mut s, "echo hi").await.stdout, "hi\n");

		sh(&mut s, "exec 2>/dev/null").await;
		let missing = sh(&mut s, "ls /nope").await;
		assert_ne!(missing.outcome.status, 0);
		assert!(missing.stderr.contains("/nope"), "stderr: {:?}", missing.stderr);

		let dir = tempfile::tempdir().unwrap();
		let input = dir.path().join("input");
		std::fs::write(&input, "first\nsecond\n").unwrap();
		let command = format!("exec <'{}'; read -r x; echo \"$x\"", input.display());
		assert_eq!(sh(&mut s, &command).await.stdout, "first\n");
		assert_eq!(sh(&mut s, "read -r x || echo eof").await.stdout, "eof\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn exec_higher_fds_persist_across_runs() {
		let mut s = session();
		let dir = tempfile::tempdir().unwrap();
		let output = dir.path().join("output");
		let command = format!("exec 3>'{}' 4>&1", output.display());
		assert_eq!(sh(&mut s, &command).await.outcome.status, 0);
		let c = sh(&mut s, "echo file >&3; echo captured >&4").await;
		assert_eq!(c.stdout, "captured\n");
		assert_eq!(std::fs::read_to_string(output).unwrap(), "file\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn background_output_stays_with_starting_run() {
		for command in [
			"(sleep 0.3; echo late) &",
			"(sleep 0.3; /bin/echo late) &",
			"{ sleep 0.3; echo late >&2; } &",
		] {
			let mut s = session();
			s.run(command, RunStdio::default(), CancellationToken::new())
				.await
				.unwrap();
			let next = sh(&mut s, "sleep 1; echo second").await;
			assert_eq!(next.stdout, "second\n", "{command}");
			assert_eq!(next.stderr, "", "{command}");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn background_output_is_captured_when_waited_in_starting_run() {
		let mut s = session();
		let c = sh(&mut s, "(sleep 0.1; echo job; echo error >&2) & wait").await;
		assert_eq!((c.outcome.status, c.stdout.as_str(), c.stderr.as_str()), (0, "job\n", "error\n"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn background_external_holding_pipe_does_not_delay_run() {
		let mut s = session();
		let (_reader, writer) = io::pipe().unwrap();
		let stdio = RunStdio {
			stdout: Some(std::fs::File::from(std::os::fd::OwnedFd::from(writer))),
			..RunStdio::default()
		};
		// The job outlives the runner's bound: a run it delayed would hang the
		// test until the runner fails it.
		let command = format!(
			"{} {} &",
			crate::testkit::child::on_path("sleep"),
			crate::testkit::child::LIFETIME.as_secs()
		);
		let outcome = s
			.run(&command, stdio, CancellationToken::new())
			.await
			.unwrap();
		assert_eq!(outcome.status, 0);
		assert_eq!(sh(&mut s, "kill %1; wait %1").await.outcome.status, 128 + libc::SIGTERM);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn background_job_remains_waitable_in_later_run() {
		let mut s = session();
		s.run("(sleep 0.1; exit 7) &", RunStdio::default(), CancellationToken::new())
			.await
			.unwrap();
		assert_eq!(sh(&mut s, "sleep 0.3; wait %1").await.outcome.status, 7);
	}

	/// [`sh`], but a stream still open `limit` after the command fails the
	/// test instead of hanging it.
	async fn sh_within(session: &mut Session, command: &str, limit: Duration) -> Captured {
		let (out_r, out_w) = io::pipe().unwrap();
		let (err_r, err_w) = io::pipe().unwrap();
		let drain = |mut r: io::PipeReader| {
			let (tx, rx) = std::sync::mpsc::channel();
			std::thread::spawn(move || {
				let mut s = String::new();
				r.read_to_string(&mut s).unwrap();
				let _ = tx.send(s);
			});
			rx
		};
		let (out, err) = (drain(out_r), drain(err_r));
		let stdio = RunStdio {
			stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
			stdout: Some(std::fs::File::from(std::os::fd::OwnedFd::from(out_w))),
			stderr: Some(std::fs::File::from(std::os::fd::OwnedFd::from(err_w))),
		};
		let outcome = session
			.run_with(RunOptions::new(command), stdio, CancellationToken::new())
			.await
			.unwrap();
		let end = Instant::now() + limit;
		let read = |rx: std::sync::mpsc::Receiver<String>| {
			rx.recv_timeout(end.saturating_duration_since(Instant::now()))
				.unwrap_or_else(|_| panic!("{command}: output still open {limit:?} after the command"))
		};
		Captured { outcome, stdout: read(out), stderr: read(err) }
	}

	/// A process substitution still running when its command ends keeps
	/// the command's output open, as bash's keeps the descriptors it
	/// inherited: what it writes after the command reaches the caller, and
	/// the output ends when it ends. A command substitution reads until it
	/// ends too. Each row is what bash 5.3.20 and 5.2.21 print.
	#[tokio::test(flavor = "multi_thread")]
	async fn process_substitution_output_outlives_its_command() {
		for (command, expected) in [
			("/bin/echo hi > >(sleep 0.2; /bin/cat); echo after", "after\nhi\n"),
			("echo hi > >(sleep 0.2; /bin/cat); echo after", "after\nhi\n"),
			(
				"printf 'a\\nb\\n' > >(sleep 0.2; while read l; do echo \"<$l>\"; done); echo after",
				"after\n<a>\n<b>\n",
			),
			(
				"/bin/echo hi > >(sleep 0.1; /bin/cat > >(sleep 0.1; /bin/cat)); echo after",
				"after\nhi\n",
			),
			("( /bin/echo hi > >(sleep 0.2; /bin/cat); echo in ); echo after", "in\nafter\nhi\n"),
			("exec > >(sleep 0.2; /bin/cat); echo hi; echo after", "hi\nafter\n"),
			("x=$(/bin/echo hi > >(sleep 0.2; /bin/cat)); echo \"[$x]\"", "[hi]\n"),
			("x=$( ( /bin/echo hi > >(sleep 0.2; /bin/cat) ) ); echo \"[$x]\"", "[hi]\n"),
		] {
			let mut s = session();
			let c = sh_within(&mut s, command, Duration::from_secs(10)).await;
			assert_eq!(
				(c.outcome.status, c.stdout.as_str(), c.stderr.as_str()),
				(0, expected, ""),
				"{command}"
			);
			let next = sh_within(&mut s, "echo next", Duration::from_secs(10)).await;
			assert_eq!(next.stdout, "next\n", "after {command}");
		}
	}

	/// A substitution an earlier command left running (on a descriptor
	/// that persists) writes to that command's streams, never a later
	/// command's.
	#[tokio::test(flavor = "multi_thread")]
	async fn an_earlier_process_substitution_stays_out_of_later_commands() {
		let mut s = session();
		s.run("exec 3> >(/bin/cat)", RunStdio::default(), CancellationToken::new())
			.await
			.unwrap();
		let c = sh_within(&mut s, "echo to3 >&3; sleep 0.2; echo own", Duration::from_secs(10)).await;
		assert_eq!((c.stdout.as_str(), c.stderr.as_str()), ("own\n", ""));
		let c = sh_within(&mut s, "exec 3>&-; sleep 0.2; echo closed", Duration::from_secs(10)).await;
		assert_eq!((c.stdout.as_str(), c.stderr.as_str()), ("closed\n", ""));
	}

	/// Without a process substitution still running, a command's streams
	/// close when it ends: a background job's later output is dropped, not
	/// delivered to the caller.
	#[tokio::test(flavor = "multi_thread")]
	async fn background_output_after_the_command_is_dropped() {
		for command in [
			"{ sleep 0.3; echo late; } &",
			"{ sleep 0.3; echo late >&2; } &",
			": > >(:); { sleep 0.3; echo late; } &",
		] {
			let mut s = session();
			let c = sh_within(&mut s, command, Duration::from_secs(10)).await;
			assert_eq!((c.stdout.as_str(), c.stderr.as_str()), ("", ""), "{command}");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn statuses_follow_bash() {
		let mut s = session();
		assert_eq!(sh(&mut s, "false").await.outcome.status, 1);
		let c = sh(&mut s, "nosuchcmd").await;
		assert_eq!(c.outcome.status, 127);
		assert!(c.stderr.contains("nosuchcmd: command not found"), "stderr: {:?}", c.stderr);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn state_persists_across_runs() {
		let mut s = session();
		let dir = tempfile::tempdir().unwrap();
		let dir = dir.path().canonicalize().unwrap();
		let cd = format!("x=41; f() {{ echo \"f$((x + 1))\"; }}; cd '{}'", dir.display());
		assert_eq!(sh(&mut s, &cd).await.outcome.status, 0);
		let c = sh(&mut s, "f; pwd").await;
		assert_eq!(c.stdout, format!("f42\n{}\n", dir.display()));
		assert_eq!(c.outcome.cwd, BString::from(dir.as_os_str().as_bytes()));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn per_run_env_is_visible_in_that_run_only() {
		let mut s = session();
		sh(&mut s, "KEEP=old").await;
		let options = RunOptions {
			env: vec![("ONLY".into(), "one".into()), ("KEEP".into(), "new".into())],
			..RunOptions::new("echo \"$ONLY $KEEP\"; env | grep '^ONLY='")
		};
		let c = capture(&mut s, options).await;
		assert_eq!(c.stdout, "one new\nONLY=one\n");
		let c = sh(&mut s, "echo \"${ONLY-unset} $KEEP\"").await;
		assert_eq!(c.stdout, "unset old\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn cwd_override_applies_and_persists() {
		let mut s = session();
		let dir = tempfile::tempdir().unwrap();
		let dir = dir.path().canonicalize().unwrap();
		let path = BString::from(dir.as_os_str().as_bytes());
		let options = RunOptions { cwd: Some(path.clone()), ..RunOptions::new("/bin/pwd") };
		let c = capture(&mut s, options).await;
		assert_eq!(c.stdout, format!("{}\n", dir.display()));
		assert_eq!(sh(&mut s, "pwd").await.outcome.cwd, path);
		let err = s
			.run_with(
				RunOptions { cwd: Some("rel".into()), ..RunOptions::new(":") },
				RunStdio::default(),
				CancellationToken::new(),
			)
			.await
			.unwrap_err();
		assert!(matches!(err, SessionError::RelativeCwd(_)));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn exit_ends_the_command_not_the_session() {
		let mut s = session();
		assert_eq!(sh(&mut s, "y=7; exit 3; y=8").await.outcome.status, 3);
		assert_eq!(sh(&mut s, "set -e; false; echo no").await.outcome.status, 1);
		let c = sh(&mut s, "echo $y").await;
		assert_eq!((c.outcome.status, c.stdout.as_str()), (0, "7\n"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn outcome_says_whether_exit_ended_the_command() {
		let mut s = session();
		assert!(!sh(&mut s, "false").await.outcome.exited);
		assert!(sh(&mut s, "exit 0").await.outcome.exited);
		assert!(sh(&mut s, "set -e; false; echo no").await.outcome.exited);
		assert!(!sh(&mut s, "set +e; (exit 4)").await.outcome.exited);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn live_external_jobs_counts_background_externals_until_they_end() {
		let mut s = session();
		assert_eq!(s.live_external_jobs().await.unwrap(), 0);
		// The sleep writes elsewhere: holding the captured pipes, as an
		// external started in the background does, it would keep `capture`
		// reading until it exits.
		let started = sh(&mut s, "/bin/sleep 30 >/dev/null 2>&1 & { :; } &").await;
		assert_eq!(started.outcome.status, 0);
		assert_eq!(s.live_external_jobs().await.unwrap(), 1);
		assert_eq!(sh(&mut s, "kill %1; wait %1").await.outcome.status, 143);
		assert_eq!(s.live_external_jobs().await.unwrap(), 0);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn pipe_taps_and_reported_errors_last_one_run() {
		#[derive(Default)]
		struct Taps(Mutex<Vec<(String, String, Arc<Mirror>)>>);
		#[derive(Default)]
		struct Mirror(Mutex<(Vec<u8>, bool)>);
		impl PipeTap for Taps {
			fn open(
				&self,
				producer: &bstr::BStr,
				consumer: &bstr::BStr,
			) -> Option<Arc<dyn crate::bash::PipeMirror>> {
				let mirror = Arc::new(Mirror::default());
				self
					.0
					.lock()
					.push((producer.to_string(), consumer.to_string(), Arc::clone(&mirror)));
				Some(mirror)
			}
		}
		impl crate::bash::PipeMirror for Mirror {
			fn write(&self, bytes: &[u8]) {
				self.0.lock().0.extend_from_slice(bytes);
			}

			fn close(&self) {
				self.0.lock().1 = true;
			}
		}

		let mut s = session();
		let taps = Arc::new(Taps::default());
		let options = RunOptions {
			pipe_tap: Some(Arc::clone(&taps) as Arc<dyn PipeTap>),
			reported_error: Some(Arc::new(AtomicBool::new(false))),
			..RunOptions::new("printf 'x\\ny\\n' | /usr/bin/sort -r")
		};
		let c = capture(&mut s, options).await;
		assert_eq!(c.stdout, "y\nx\n");
		{
			let taps = taps.0.lock();
			let [(producer, consumer, mirror)] = taps.as_slice() else {
				panic!("one tapped pipe: {}", taps.len());
			};
			assert!(producer.starts_with("printf") && consumer.contains("sort"));
			assert_eq!(*mirror.0.lock(), (b"x\ny\n".to_vec(), true));
		}
		// The next run is untapped.
		sh(&mut s, "printf z | /usr/bin/sort").await;
		assert_eq!(taps.0.lock().len(), 1);
	}

	/// `tail -f` into an external stops once that reader is gone: it asks
	/// with an empty write, which the shared OS pipe must answer as the
	/// memory pipe does (`BrokenPipe`), or `tail` follows the idle file for
	/// good. `tail` (a builtin) opens its stdout while the pipe is still in
	/// memory; `head` (an external) turns it into an OS pipe. The bound only
	/// turns a hang into a failure.
	#[tokio::test(flavor = "multi_thread")]
	async fn tail_f_into_an_external_stops_once_its_reader_is_gone() {
		let dir = tempfile::tempdir().unwrap();
		let log = dir.path().join("app.log");
		std::fs::write(&log, "first\nsecond\n").unwrap();
		let mut s = session();
		let cmd = format!("tail -f '{}' | /usr/bin/head -n 1; echo done", log.display());
		let c = tokio::time::timeout(Duration::from_secs(60), sh(&mut s, &cmd))
			.await
			.expect("tail -f did not stop within 60 s after its reader left");
		assert_eq!(c.stdout, "first\ndone\n");
	}

	/// Between two external stages a tapped pipe stays in memory, pumped, so
	/// the tap and the run's trace see every byte in order. On Linux (the
	/// probe reads `/proc`, and only Linux shares the pipe), the stages of a
	/// tapped pipe each have a pipe of their own to the shell, and an
	/// untapped pipe between the same stages is one OS pipe.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_tapped_pipe_between_externals_mirrors_every_byte_and_an_untapped_one_is_shared() {
		#[derive(Default)]
		struct Taps(Mutex<Vec<Arc<Mirror>>>);
		#[derive(Default)]
		struct Mirror(Mutex<(Vec<u8>, bool)>);
		impl PipeTap for Taps {
			fn open(
				&self,
				_producer: &bstr::BStr,
				_consumer: &bstr::BStr,
			) -> Option<Arc<dyn crate::bash::PipeMirror>> {
				let mirror = Arc::new(Mirror::default());
				self.0.lock().push(Arc::clone(&mirror));
				Some(mirror)
			}
		}
		impl crate::bash::PipeMirror for Mirror {
			fn write(&self, bytes: &[u8]) {
				self.0.lock().0.extend_from_slice(bytes);
			}

			fn close(&self) {
				self.0.lock().1 = true;
			}
		}
		const ONE_PIPE: &str = "w=$(/bin/mktemp -d); /bin/sh -c 'x=$(readlink /proc/$$/fd/1); \
		                        printf \"%s\\n\" \"$x\" > \"$1/w\"' sh \"$w\" | /bin/sh -c \
		                        'x=$(readlink /proc/$$/fd/0); printf \"%s\\n\" \"$x\" > \"$1/r\"' \
		                        sh \"$w\"; if [ \"$(/bin/cat \"$w/w\")\" = \"$(/bin/cat \"$w/r\")\" \
		                        ]; then echo one-pipe; else echo two-pipes; fi; /bin/rm -rf \"$w\"";
		// awk, not wc, whose count BSD pads with spaces.
		const SEQ: &str = "/usr/bin/seq 1 20000 | /usr/bin/awk 'END { print NR }'";
		let seq: String = (1..=20000).map(|n| n.to_string() + "\n").collect();
		let mut s = session();
		let tapped =
			|command: &str, taps: &Arc<Taps>, trace: &Arc<crate::bash::trace::RunTrace>| RunOptions {
				pipe_tap: Some(Arc::clone(taps) as Arc<dyn PipeTap>),
				events: Some(Arc::clone(trace) as Arc<dyn crate::bash::EventSink>),
				text_capture: true,
				..RunOptions::new(command)
			};
		let taps = Arc::new(Taps::default());
		let trace = Arc::new(crate::bash::trace::RunTrace::new(SEQ));
		let c = capture(&mut s, tapped(SEQ, &taps, &trace)).await;
		assert_eq!(c.stdout, "20000\n");
		{
			let taps = taps.0.lock();
			let [mirror] = taps.as_slice() else {
				panic!("one tapped pipe: {}", taps.len());
			};
			let (bytes, closed) = &*mirror.0.lock();
			assert!(bytes.as_slice() == seq.as_bytes() && *closed, "the tap saw every byte in order");
		}
		assert_eq!(trace_output(&trace.snapshot()), c.stdout);
		if cfg!(target_os = "linux") {
			let trace = Arc::new(crate::bash::trace::RunTrace::new(ONE_PIPE));
			let c = capture(&mut s, tapped(ONE_PIPE, &Arc::new(Taps::default()), &trace)).await;
			assert_eq!(c.stdout, "two-pipes\n", "a tapped pipe stays in memory");
			assert_eq!(sh(&mut s, ONE_PIPE).await.stdout, "one-pipe\n", "an untapped one is shared");
		}
		let (c, trace) = trace_capture(&mut s, SEQ).await;
		assert_eq!(c.stdout, "20000\n");
		assert_eq!(trace_output(&trace.snapshot()), c.stdout, "the trace sees the last stage");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn url_paths_are_absolute_working_directories() {
		let mut s = session();
		// No provider serves the scheme: the directory check fails, the
		// path is not joined onto the current directory.
		let c = sh(&mut s, "cd virtual://nowhere").await;
		assert_ne!(c.outcome.status, 0);
		assert!(c.stderr.contains("virtual://nowhere"), "stderr: {:?}", c.stderr);
		assert!(!c.stderr.contains("/virtual:"), "joined onto the cwd: {:?}", c.stderr);
		let options = RunOptions { cwd: Some("virtual://dir".into()), ..RunOptions::new(":") };
		let outcome = s
			.run_with(options, RunStdio::default(), CancellationToken::new())
			.await
			.unwrap();
		assert_eq!(outcome.cwd, "virtual://dir");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn pipeline_into_an_external() {
		let mut s = session();
		let c = sh(&mut s, "printf 'a\\nb\\n' | /usr/bin/sort -r").await;
		assert_eq!((c.outcome.status, c.stdout.as_str()), (0, "b\na\n"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn external_runs_in_its_own_session_and_cancel_stops_it() {
		let mut s = session();
		let children = s.children();
		let cancel = CancellationToken::new();
		let probe = {
			let cancel = cancel.clone();
			let children = children.clone();
			async move {
				let pid = loop {
					if let Some(&pid) = children.pids().first() {
						break pid;
					}
					tokio::time::sleep(Duration::from_millis(10)).await;
				};
				// SAFETY: getpgid/getsid/getpgrp only read process ids.
				let ids = unsafe { (libc::getpgid(pid), libc::getsid(pid), libc::getpgrp()) };
				cancel.cancel();
				(pid, ids)
			}
		};
		// The sleep (600 s, `testkit::child::LIFETIME`) outlives the test
		// runner's bound, so only the cancel ends it.
		let sleep = format!("{} 600", crate::testkit::child::on_path("sleep"));
		let (outcome, (pid, (pgid, sid, own_group))) =
			tokio::join!(s.run(&sleep, RunStdio::default(), cancel.clone()), probe);
		let outcome = outcome.unwrap();
		assert!(outcome.cancelled);
		// 143, not 137: the run ended on the cancel's TERM, inside the
		// session's own grace, rather than by its KILL after it.
		assert_eq!(outcome.status, 143);
		assert_eq!((pgid, sid), (pid, pid), "the external leads its own session");
		assert_ne!(pgid, own_group);
		assert!(children.pids().is_empty(), "no run in flight");
		// Waits as long as that takes: a sleep the cancel did not reach hangs
		// the test until the runner's timeout.
		while !crate::sys::proc::ended(pid) {
			tokio::time::sleep(Duration::from_millis(20)).await;
		}
		// The session is still usable.
		assert_eq!(sh(&mut s, "echo ok").await.stdout, "ok\n");
	}

	/// A cancel the TERM trap catches is escalated to KILL. The cancel comes
	/// once the script says its trap is set: a cancel that reaches the run
	/// before the `trap` command ends it by the TERM itself (143), and a
	/// fixed 200 ms delay lost that race on a loaded machine.
	#[tokio::test(flavor = "multi_thread")]
	async fn trapped_term_escalates_to_kill() {
		let mut s = session();
		let cancel = CancellationToken::new();
		let (reader, writer) = io::pipe().unwrap();
		let stdio = RunStdio {
			stdout: Some(std::fs::File::from(std::os::fd::OwnedFd::from(writer))),
			..RunStdio::default()
		};
		let trigger = cancel.clone();
		let armed = std::thread::spawn(move || {
			let mut line = String::new();
			let _ = io::BufRead::read_line(&mut io::BufReader::new(reader), &mut line);
			trigger.cancel();
			line
		});
		// The TERM trap loops for ever, so only the KILL ends the run (137); a
		// cancel that never escalated would hang the test until the runner's
		// bound.
		let outcome = s
			.run("trap 'while :; do :; done' TERM; echo armed; while :; do :; done", stdio, cancel)
			.await
			.unwrap();
		assert_eq!(armed.join().unwrap(), "armed\n", "the cancel came once the trap was set");
		assert!(outcome.cancelled);
		assert_eq!(outcome.status, 137);
	}

	#[test]
	fn signals_to_pi_and_its_ancestors_are_refused() {
		use crate::host::check_signal_target;
		let me = i32::try_from(std::process::id()).unwrap();
		// SAFETY: getppid/getpgrp have no preconditions.
		let (parent, group) = unsafe { (libc::getppid(), libc::getpgrp()) };
		for pid in [me, parent, 0, -1, -group] {
			let err = check_signal_target(pid).unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "pid {pid}");
		}
		let mut child = std::process::Command::new("/bin/sleep")
			.arg("5")
			.spawn()
			.unwrap();
		let pid = i32::try_from(child.id()).unwrap();
		assert!(check_signal_target(pid).is_ok());
		child.kill().unwrap();
		child.wait().unwrap();
	}

	/// The guard fails closed: with no descriptor left to read the process
	/// table, a signal at the shell's parent is still refused (the kernel
	/// names the parent), and so is one at any other process, with the
	/// reason, since it may be an ancestor above. The unreadable case runs
	/// in a child test process ([`crate::sys::proc::short_of_descriptors`]);
	/// first, the control: with every process readable, the parent is
	/// refused and the unrelated `sleep` is not.
	#[cfg(target_os = "linux")]
	#[test]
	fn signals_are_refused_while_the_ancestors_cannot_be_read() {
		use crate::{host::check_signal_target, sys::proc::short_of_descriptors};
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.unwrap();
		let pid = child.id();
		// SAFETY: getppid has no preconditions.
		let parent = unsafe { libc::getppid() };
		let readable =
			(check_signal_target(parent), check_signal_target(i32::try_from(pid).unwrap()));
		let probed =
			short_of_descriptors::run("session::tests::signal_target_with_no_descriptor_left", pid);
		child.kill().unwrap();
		child.wait().unwrap();
		assert_eq!(readable.0.unwrap_err().kind(), io::ErrorKind::PermissionDenied, "the parent");
		assert!(readable.1.is_ok(), "the unrelated sleep {pid}: {:?}", readable.1);
		probed.unwrap();
	}

	/// Run by [`signals_are_refused_while_the_ancestors_cannot_be_read`] in
	/// a child process with no descriptor left.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by signals_are_refused_while_the_ancestors_cannot_be_read"]
	fn signal_target_with_no_descriptor_left() {
		use crate::{host::check_signal_target, sys::proc::short_of_descriptors};
		let Some(sleep) = short_of_descriptors::pid() else {
			return;
		};
		// SAFETY: getppid has no preconditions.
		let parent = unsafe { libc::getppid() };
		short_of_descriptors::leave_none();
		let me = i32::try_from(std::process::id()).unwrap();
		assert!(crate::sys::proc::info(me).is_none(), "/proc/{me}/stat could still be read");
		assert!(crate::sys::proc::info(parent).is_none(), "/proc/{parent}/stat could still be read");
		let err =
			check_signal_target(parent).expect_err("the signal at the unreadable parent went through");
		assert_eq!(err.to_string(), "refusing to signal the shell process");
		let err = check_signal_target(sleep)
			.expect_err("the signal went through while the ancestors were unread");
		assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
		let said = format!(
			"cannot read process {parent} to check it is not the shell's ancestor: Too many open \
			 files"
		);
		assert_eq!(err.to_string(), said);
	}

	/// Without `/proc` (every read of `/proc/<pid>/stat` is `ENOENT`,
	/// simulated) the shell cannot walk its own ancestors, so the guard has
	/// nothing to check: a signal at any process but this one and its group
	/// goes through, as in a shell without the guard.
	#[cfg(target_os = "linux")]
	#[test]
	fn without_proc_the_guard_refuses_only_this_process() {
		use crate::{host::check_signal_target, sys::proc::fail_reads};
		let mut child = crate::testkit::child::dies_with_this_process(
			std::process::Command::new("sleep").arg("600"),
		)
		.spawn()
		.unwrap();
		let pid = i32::try_from(child.id()).unwrap();
		let me = i32::try_from(std::process::id()).unwrap();
		let checked = {
			let _absent = fail_reads(vec![(None, libc::ENOENT)]);
			(check_signal_target(pid), check_signal_target(me), check_signal_target(0))
		};
		child.kill().unwrap();
		child.wait().unwrap();
		assert!(checked.0.is_ok(), "the sleep {pid}: {:?}", checked.0);
		assert!(checked.1.is_err() && checked.2.is_err(), "this process and its group: {checked:?}");
	}

	/// With `/proc` mounted, an ancestor whose read fails with `ENOENT`
	/// while a signal still reaches it (simulated for the shell's parent) is
	/// unread, not gone: in our pid namespace that is a race with its exit or
	/// a reuse of its pid, so every signal is refused, naming the pid and the
	/// error.
	#[cfg(target_os = "linux")]
	#[test]
	fn an_ancestor_read_enoent_while_proc_is_mounted_refuses_every_signal() {
		use crate::{host::check_signal_target, sys::proc::fail_reads};
		let mut child = crate::testkit::child::dies_with_this_process(
			std::process::Command::new("sleep").arg("600"),
		)
		.spawn()
		.unwrap();
		let pid = i32::try_from(child.id()).unwrap();
		// SAFETY: getppid has no preconditions.
		let parent = unsafe { libc::getppid() };
		let checked = {
			let _unread = fail_reads(vec![(Some(parent), libc::ENOENT)]);
			check_signal_target(pid)
		};
		child.kill().unwrap();
		child.wait().unwrap();
		let err = checked.expect_err("the signal went through while the parent was unread");
		let said = format!(
			"cannot read process {parent} to check it is not the shell's ancestor: No such file or \
			 directory"
		);
		assert_eq!((err.kind(), err.to_string()), (io::ErrorKind::PermissionDenied, said));
	}

	/// [`crate::sys::proc::read`] proves a process out of reach only when no
	/// signal of ours reaches it: a reaped child is, whatever the read said
	/// (`ESRCH`, or a refusal: `ENOENT`, `EACCES`, `EPERM`); a refused read of
	/// a running child we may signal is not (no `/proc`, another pid
	/// namespace's, a set-user-ID child), nor is a failure that proves nothing
	/// (`EMFILE`).
	#[cfg(unix)]
	#[test]
	fn a_failed_read_proves_a_process_out_of_reach_only_when_no_signal_reaches_it() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.unwrap();
		let pid = i32::try_from(child.id()).unwrap();
		let running = crate::sys::proc::read(pid);
		let reach = |errno| crate::sys::proc::out_of_reach(pid, &io::Error::from_raw_os_error(errno));
		let refused_while_running =
			[libc::ENOENT, libc::EACCES, libc::EPERM, libc::EMFILE].map(reach);
		child.kill().unwrap();
		child.wait().unwrap();
		assert!(matches!(&running, Ok(Some(found)) if found.pid == pid), "{running:?}");
		assert_eq!(
			refused_while_running, [false; 4],
			"ENOENT, EACCES, EPERM, EMFILE for a running child"
		);
		for errno in [libc::ESRCH, libc::ENOENT, libc::EACCES, libc::EPERM] {
			assert!(reach(errno), "errno {errno} for the reaped child");
		}
		assert!(!reach(libc::EMFILE), "EMFILE proves nothing, even for the reaped child");
		assert!(matches!(crate::sys::proc::read(pid), Ok(None)), "the reaped child");
	}

	/// Runs `trap '' PIPE; echo y; echo "status=$?" >&2` with fd 1 a pipe
	/// nothing reads, on the writer-thread route (the test's child process),
	/// with or without a trace: what fd 2 got.
	#[cfg(target_os = "linux")]
	fn echo_into_a_pipe_whose_reader_is_gone(traced: bool) -> String {
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(1)
			.enable_all()
			.build()
			.unwrap();
		runtime.block_on(async {
			let mut s = session();
			let (reader, writer) = io::pipe().unwrap();
			drop(reader);
			let (mut err_r, err_w) = io::pipe().unwrap();
			let errors = std::thread::spawn(move || {
				let mut e = String::new();
				err_r.read_to_string(&mut e).unwrap();
				e
			});
			let stdio = RunStdio {
				stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
				stdout: Some(std::fs::File::from(std::os::fd::OwnedFd::from(writer))),
				stderr: Some(std::fs::File::from(std::os::fd::OwnedFd::from(err_w))),
			};
			let script = "trap '' PIPE; echo y; echo \"status=$?\" >&2";
			let events = if traced {
				Some(Arc::new(crate::bash::trace::RunTrace::new(script)) as Arc<dyn EventSink>)
			} else {
				None
			};
			let options = RunOptions { events, ..RunOptions::new(script) };
			tokio::time::timeout(
				std::time::Duration::from_secs(10),
				s.run_with(options, stdio, CancellationToken::new()),
			)
			.await
			.unwrap_or_else(|_| panic!("DEADLINE fired: the run did not return within 10 s"))
			.unwrap();
			errors.join().unwrap()
		})
	}

	/// A builtin's write that a descriptor's writer thread took and that
	/// then failed (nothing reads the pipe any more) fails that builtin: a
	/// write ends only at its flush, so `echo` reports the write error and
	/// exits 1, and the failure is never lost. The writer thread is forced
	/// in this test's child process, as Darwin always uses it.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_write_that_fails_after_its_hand_off_fails_its_builtin() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_write_that_fails_after_its_hand_off_fails_its_builtin"),
			|| {
				let errors = echo_into_a_pipe_whose_reader_is_gone(false);
				assert!(errors.contains("status=1"), "echo's status: {errors:?}");
				assert!(errors.contains("Broken pipe"), "echo reports its write error: {errors:?}");
			},
		);
	}

	/// The same under a trace, where the command's visible output fds are
	/// tagged with the command ([`crate::bash::FdRef::with_tag`]): the tagged
	/// fd hands the writer thread's mark back, so the failure still reaches
	/// `echo`.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_write_that_fails_after_its_hand_off_fails_its_builtin_under_a_trace() {
		crate::sys::in_blocking_writer_process(
			concat!(
				module_path!(),
				"::a_write_that_fails_after_its_hand_off_fails_its_builtin_under_a_trace"
			),
			|| {
				let errors = echo_into_a_pipe_whose_reader_is_gone(true);
				assert!(errors.contains("status=1"), "echo's status: {errors:?}");
				assert!(errors.contains("Broken pipe"), "echo reports its write error: {errors:?}");
			},
		);
	}

	/// Runs `script` with fd 2 a full pipe, on the writer-thread route (the
	/// test's child process), and fd 1 a regular file, which holds a
	/// command's line as soon as the command wrote it. Nothing reads the pipe
	/// until the shell is seen waiting ([`held::once_the_shell_waits`]), so
	/// what a command hands to its writer thread stays there: a later
	/// command's line on fd 1 by then shows that the later command ran before
	/// the earlier command's output was out. Then the pipe is drained, and the
	/// later command must run. With `traced`, the run has a trace. Returns
	/// fd 1 while the pipe was held, fd 1 at the end, and what the drained
	/// pipe held after its fill.
	#[cfg(target_os = "linux")]
	fn run_with_held_stderr(script: &str, traced: bool) -> (String, String, String) {
		use std::os::fd::{AsRawFd, OwnedFd};

		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(2)
			.enable_all()
			.build()
			.unwrap();
		let (mut held_r, held_w) = io::pipe().unwrap();
		// SAFETY: `F_GETPIPE_SZ` takes no argument; `held_w` owns the fd.
		let capacity =
			usize::try_from(unsafe { libc::fcntl(held_w.as_raw_fd(), libc::F_GETPIPE_SZ) }).unwrap();
		std::io::Write::write_all(&mut &held_w, &vec![b'q'; capacity]).unwrap();
		let dir = tempfile::tempdir().unwrap();
		let out = dir.path().join("out");
		let out_w = std::fs::File::create(&out).unwrap();
		let (driver, writers, seen) = (runtime.handle().clone(), held::writer_threads(), out.clone());
		let held_thread = std::thread::spawn(move || {
			let while_held = held::once_the_shell_waits(&driver, &writers, || {
				std::fs::read_to_string(&seen).unwrap()
			});
			let mut all = Vec::new();
			held_r.read_to_end(&mut all).unwrap();
			(while_held, all)
		});
		runtime.block_on(async {
			let mut s = session();
			let stdio = RunStdio {
				stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
				stdout: Some(out_w),
				stderr: Some(std::fs::File::from(OwnedFd::from(held_w))),
			};
			let events = if traced {
				Some(Arc::new(crate::bash::trace::RunTrace::new(script)) as Arc<dyn EventSink>)
			} else {
				None
			};
			let options = RunOptions { events, ..RunOptions::new(script) };
			let run = s.run_with(options, stdio, CancellationToken::new());
			let _ = tokio::time::timeout(std::time::Duration::from_secs(20), run).await;
		});
		drop(runtime);
		let (while_held, all) = held_thread.join().unwrap();
		let held = while_held.unwrap_or_else(|missed| panic!("{missed}"));
		let end = std::fs::read_to_string(&out).unwrap();
		(held, end, String::from_utf8_lossy(&all[capacity.min(all.len())..]).into_owned())
	}

	/// One held-stderr case in the test's own child process: `after` is
	/// absent while fd 2 is held, and present once it drains, and the held
	/// text `held` reached fd 2.
	#[cfg(target_os = "linux")]
	fn next_command_waits_for_held_stderr(test: &str, script: &str, held: &str) {
		next_command_waits_for_held_stderr_traced(test, script, held, false);
	}

	/// [`next_command_waits_for_held_stderr`], with a trace when `traced`.
	#[cfg(target_os = "linux")]
	fn next_command_waits_for_held_stderr_traced(
		test: &str,
		script: &str,
		held: &str,
		traced: bool,
	) {
		crate::sys::in_blocking_writer_process(test, || {
			let (while_held, end, drained) = run_with_held_stderr(script, traced);
			assert!(
				!while_held.contains("after"),
				"the next command ran before the earlier command's output was out: {while_held:?}"
			);
			assert!(end.contains("after"), "the next command never ran once fd 2 drained: {end:?}");
			assert!(drained.contains(held), "the held output never reached fd 2: {drained:?}");
		});
	}

	/// A diagnostic (`Kernel::diag`, written by `flush_out`).
	#[cfg(target_os = "linux")]
	#[test]
	fn a_held_diagnostic_keeps_the_next_command_from_running() {
		next_command_waits_for_held_stderr(
			concat!(module_path!(), "::a_held_diagnostic_keeps_the_next_command_from_running"),
			"nosuchcmd; echo after",
			"not found",
		);
	}

	/// The same under a trace, where the command's stderr is tagged with the
	/// command ([`crate::bash::FdRef::with_tag`]): the settle reaches the
	/// tagged fd's file.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_held_diagnostic_under_a_trace_keeps_the_next_command_from_running() {
		next_command_waits_for_held_stderr_traced(
			concat!(
				module_path!(),
				"::a_held_diagnostic_under_a_trace_keeps_the_next_command_from_running"
			),
			"nosuchcmd; echo after",
			"not found",
			true,
		);
	}

	/// An xtrace line, written by `flush_out` before the command it traces.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_held_xtrace_line_keeps_its_command_from_running() {
		next_command_waits_for_held_stderr(
			concat!(module_path!(), "::a_held_xtrace_line_keeps_its_command_from_running"),
			"set -x; echo after",
			"+ echo after",
		);
	}

	/// `suspend`'s refusal (`extras::Refusal`).
	#[cfg(target_os = "linux")]
	#[test]
	fn a_held_refusal_keeps_the_next_command_from_running() {
		next_command_waits_for_held_stderr(
			concat!(module_path!(), "::a_held_refusal_keeps_the_next_command_from_running"),
			"suspend; echo after",
			"suspend",
		);
	}

	/// `fc -s`'s echo of the command it runs again.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_held_fc_echo_keeps_its_command_from_running() {
		next_command_waits_for_held_stderr(
			concat!(module_path!(), "::a_held_fc_echo_keeps_its_command_from_running"),
			"history -s 'echo after'; fc -s",
			"echo after",
		);
	}

	/// A tool's message (`tools::Out`, `nohup` without an operand).
	#[cfg(target_os = "linux")]
	#[test]
	fn a_held_tool_message_keeps_the_next_command_from_running() {
		next_command_waits_for_held_stderr(
			concat!(module_path!(), "::a_held_tool_message_keeps_the_next_command_from_running"),
			"nohup; echo after",
			"nohup",
		);
	}

	/// A diagnostic of a failed redirection of a compound command, held on
	/// the redirection's target, keeps the next command from running: the
	/// restore puts fd 2 back (here `/dev/null`, which takes everything at
	/// once) before the held entry settles, so the settle must wait on the
	/// file that took the bytes (fd 3, the held pipe), not on fd 2.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_held_diagnostic_on_a_restored_fd_keeps_the_next_command_from_running() {
		next_command_waits_for_held_stderr(
			concat!(
				module_path!(),
				"::a_held_diagnostic_on_a_restored_fd_keeps_the_next_command_from_running"
			),
			"exec 3>&2 2>/dev/null; { :; } 2>&3 >/nonexistent/out; echo after",
			"nonexistent",
		);
	}

	/// Runs `script` with fd `gone` (1 or 2) a pipe nothing reads, on the
	/// writer-thread route (the test's child process): what the other stream
	/// got, and how many chunks the writer threads failed.
	#[cfg(target_os = "linux")]
	fn run_into_a_readerless_pipe(script: &str, gone: i32) -> (String, usize) {
		use std::os::fd::OwnedFd;

		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(1)
			.enable_all()
			.build()
			.unwrap();
		runtime.block_on(async {
			let mut s = session();
			let (reader, readerless) = io::pipe().unwrap();
			drop(reader);
			let (mut other_r, other_w) = io::pipe().unwrap();
			let other = std::thread::spawn(move || {
				let mut text = String::new();
				other_r.read_to_string(&mut text).unwrap();
				text
			});
			let (stdout, stderr) = if gone == 1 {
				(readerless, other_w)
			} else {
				(other_w, readerless)
			};
			let stdio = RunStdio {
				stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
				stdout: Some(std::fs::File::from(OwnedFd::from(stdout))),
				stderr: Some(std::fs::File::from(OwnedFd::from(stderr))),
			};
			tokio::time::timeout(
				std::time::Duration::from_secs(10),
				s.run(script, stdio, CancellationToken::new()),
			)
			.await
			.unwrap_or_else(|_| panic!("DEADLINE fired: the run did not return within 10 s"))
			.unwrap();
			let text = other.join().unwrap();
			(text, crate::sys::CHUNKS_FAILED.load(std::sync::atomic::Ordering::SeqCst))
		})
	}

	/// A builtin's output of four chunks stops at the first one that fails:
	/// bash stops at its first failed `write(2)`. Handing off the rest sends
	/// a FIFO's next reader the tail without the head, or blocks the builtin
	/// on the tail before it reports the failure.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_builtin_stops_at_its_first_failed_chunk() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_builtin_stops_at_its_first_failed_chunk"),
			|| {
				let (errors, failed) = run_into_a_readerless_pipe(
					"trap '' PIPE; big=$(printf '%0200000d' 0); echo \"$big\"; echo \"status=$?\" >&2",
					1,
				);
				assert!(errors.contains("status=1"), "echo's status: {errors:?}");
				assert_eq!(errors.matches("Broken pipe").count(), 1, "one write error: {errors:?}");
				assert_eq!(failed, 1, "chunks handed off after the first one failed");
			},
		);
	}

	/// A diagnostic of two chunks (`Kernel::diag`, written by `flush_out`)
	/// stops at the first one that fails, and the next command runs.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_diagnostic_stops_at_its_first_failed_chunk() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_diagnostic_stops_at_its_first_failed_chunk"),
			|| {
				let (out, failed) = run_into_a_readerless_pipe(
					"big=$(printf '%070000d' 0); \"$big\"; echo \"after=$?\"",
					2,
				);
				assert!(out.contains("after=127"), "the next command: {out:?}");
				assert_eq!(failed, 1, "chunks handed off after the first one failed");
			},
		);
	}

	/// A tool's message of two chunks (`tools::Out`, `timeout`'s usage
	/// error naming its operand) stops at the first one that fails, and the
	/// next command runs.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_tool_message_stops_at_its_first_failed_chunk() {
		crate::sys::in_blocking_writer_process(
			concat!(module_path!(), "::a_tool_message_stops_at_its_first_failed_chunk"),
			|| {
				let (out, failed) = run_into_a_readerless_pipe(
					"timeout \"$(printf '%070000d' 0)x\" true; echo \"after=$?\"",
					2,
				);
				assert!(out.contains("after=125"), "the next command: {out:?}");
				assert_eq!(failed, 1, "chunks handed off after the first one failed");
			},
		);
	}

	/// How long a run of the stuck-extra tests below may take: each moves
	/// about a megabyte through a pipe, so a run still going after this is
	/// stuck, not slow.
	const STUCK: Duration = Duration::from_secs(60);

	/// A runtime of the test's own: a test that finds an extra stuck shuts it
	/// down without waiting for the thread the extra's write blocks forever.
	fn own_runtime() -> tokio::runtime::Runtime {
		tokio::runtime::Builder::new_multi_thread()
			.enable_all()
			.build()
			.unwrap()
	}

	/// Wait until `done` holds, checking every millisecond; `false` once
	/// `given_up` is set.
	fn until(done: impl Fn() -> bool, given_up: &AtomicBool) -> bool {
		while !done() {
			if given_up.load(Ordering::SeqCst) {
				return false;
			}
			std::thread::sleep(Duration::from_millis(1));
		}
		true
	}

	/// A native extra and a builtin that both wait for room on the run's
	/// stdout are both woken when its reader drains it. With an event sink
	/// (omp's live shell view) the extra writes the run's stdout through the
	/// engine's object, from a thread of its own, and the builtin writes it
	/// from the engine: two tasks wait on the one `StdFile` of the run's
	/// stdout.
	#[test]
	fn an_extra_and_a_builtin_waiting_for_room_on_stdout_both_finish() {
		extra_and_builtin_both_finish("head -c {EXTRA} /dev/zero &", true);
	}

	// Failure mode (review of #111 at 3b9fe7ab): an extra writing through a
	// zsh multios tee waited on the run's stdout with the engine's own wait,
	// which `printf`'s replaced, and the run hung. A tee has no OS handle, so
	// the extra writes through it with or without an event sink.
	#[test]
	fn an_extra_writing_through_a_multios_tee_and_a_builtin_both_finish() {
		extra_and_builtin_both_finish(
			"emulate zsh -c 'head -c {EXTRA} /dev/zero >&1 >/dev/null &'",
			true,
		);
	}

	/// The same without an event sink.
	#[test]
	fn an_extra_writing_through_a_multios_tee_without_an_event_sink_finishes() {
		extra_and_builtin_both_finish(
			"emulate zsh -c 'head -c {EXTRA} /dev/zero >&1 >/dev/null &'",
			false,
		);
	}

	/// Bytes the first writer of [`two_writers_finish`] writes: it fills
	/// the pipe and waits.
	const EXTRA: usize = 1 << 20;
	/// Bytes the second writer writes.
	const BUILTIN: usize = 1 << 17;

	/// Run `{background}`, then `read -r go; printf '%0{BUILTIN}d' 0; wait`,
	/// where `background` starts an extra writing `EXTRA` NULs to stdout
	/// (`{EXTRA}` in it is replaced). See [`two_writers_finish`].
	fn extra_and_builtin_both_finish(background: &str, events: bool) {
		two_writers_finish(
			&format!("{background}\nread -r go; printf '%0{{BUILTIN}}d' 0; wait"),
			events,
			&[(0, EXTRA), (b'0', BUILTIN)],
		);
	}

	/// Run `command` (`{EXTRA}` and `{BUILTIN}` in it are replaced): a first
	/// writer fills the run's stdout and waits for room, `read -r go` lets a
	/// second one start, and it waits too; then a reader drains the pipe a
	/// chunk at a time. The run must finish within [`STUCK`] with status 0
	/// and stdout must hold exactly `expect` (byte, count).
	fn two_writers_finish(command: &str, events: bool, expect: &[(u8, usize)]) {
		let got = writers_read(command, events, 2);
		assert_eq!(got, expect, "stdout (byte, count) from `{command}`");
	}

	/// [`two_writers_finish`]'s run with `writers` writers (1 or 2; with 1,
	/// the reader drains once it waits); the (byte, count) of each byte on
	/// stdout.
	fn writers_read(command: &str, events: bool, writers: usize) -> Vec<(u8, usize)> {
		use std::{io::Write, os::fd::AsRawFd, sync::atomic::AtomicUsize};
		let command = command
			.replace("{EXTRA}", &EXTRA.to_string())
			.replace("{BUILTIN}", &BUILTIN.to_string());
		let (mut out_r, out_w) = io::pipe().unwrap();
		let (in_r, mut in_w) = io::pipe().unwrap();
		let out_w = std::fs::File::from(std::os::fd::OwnedFd::from(out_w));
		let fd = out_w.as_raw_fd();
		let waited = crate::sys::pending_polls(fd);
		// How many of each byte the reader read; how far it got; whether the
		// test gave up.
		let read: Arc<Vec<AtomicUsize>> = Arc::new((0..256).map(|_| AtomicUsize::new(0)).collect());
		let stage = Arc::new(AtomicU8::new(0));
		let given_up = Arc::new(AtomicBool::new(false));
		let reader = {
			let (read, stage, given_up) =
				(Arc::clone(&read), Arc::clone(&stage), Arc::clone(&given_up));
			std::thread::spawn(move || {
				// The first writer filled the pipe and waits for room.
				if !until(|| crate::sys::pending_polls(fd) > waited, &given_up) {
					return;
				}
				stage.store(1, Ordering::SeqCst);
				in_w.write_all(b"go\n").unwrap();
				// The second waits for room too, on the same file.
				if writers > 1 && !until(|| crate::sys::pending_polls(fd) > waited + 1, &given_up) {
					return;
				}
				stage.store(2, Ordering::SeqCst);
				// A slow reader, 4 KiB at a time, so both writers keep
				// waiting for room while it drains.
				let mut buf = vec![0u8; 4 << 10];
				loop {
					let n = out_r.read(&mut buf).unwrap();
					if n == 0 {
						break;
					}
					for &b in &buf[..n] {
						read[usize::from(b)].fetch_add(1, Ordering::SeqCst);
					}
					std::thread::sleep(Duration::from_micros(500));
				}
			})
		};
		let counts = |read: &[AtomicUsize]| -> Vec<(u8, usize)> {
			(0..=255u8)
				.map(|b| (b, read[usize::from(b)].load(Ordering::SeqCst)))
				.filter(|&(_, n)| n > 0)
				.collect()
		};
		let runtime = own_runtime();
		let ended = runtime.block_on(async {
			let mut session = session();
			let stdio = RunStdio {
				stdin:  Some(std::fs::File::from(std::os::fd::OwnedFd::from(in_r))),
				stdout: Some(out_w),
				stderr: Some(std::fs::File::open("/dev/null").unwrap()),
			};
			let mut options = RunOptions::new(command.as_str());
			if events {
				options.events = Some(Arc::new(crate::bash::trace::RunTrace::new(command.as_str())));
			}
			tokio::time::timeout(STUCK, session.run_with(options, stdio, CancellationToken::new()))
				.await
		});
		let Ok(outcome) = ended else {
			given_up.store(true, Ordering::SeqCst);
			let reached = [
				"the first writer never waited for room on stdout",
				"the second writer never waited for room on stdout",
				"both waited and the reader drained the pipe",
			][usize::from(stage.load(Ordering::SeqCst))];
			let got = counts(&read);
			// A stuck extra's thread waits forever: leave it.
			runtime.shutdown_background();
			panic!(
				"the run never ended ({reached}): stdout held (byte, count) {got:?} from `{command}`"
			);
		};
		assert_eq!(outcome.unwrap().status, 0);
		reader.join().unwrap();
		counts(&read)
	}

	// Failure mode (review of #111 at bd60965e): a zsh multios tee kept one
	// progress for all its writers. An extra and `printf` writing through
	// one tee to a slow reader used each other's progress: stdout held
	// 229,376 to 901,120 NULs and 425,984 to 3,309,568 '0's, and the run
	// ended with status 0.
	#[test]
	fn an_extra_and_a_builtin_through_one_multios_tee_write_their_bytes_once() {
		two_writers_finish(
			"emulate zsh -c '{ head -c {EXTRA} /dev/zero & read -r go; printf %0{BUILTIN}d 0; wait; \
			 } >&1 >/dev/null'",
			true,
			&[(0, EXTRA), (b'0', BUILTIN)],
		);
	}

	// Failure mode (review of #111 at bd60965e): two vprocs writing through
	// one tee wrote as one writer, the engine, and used each other's
	// progress. Each vproc writes with its own key.
	#[test]
	fn two_builtins_through_one_multios_tee_write_their_bytes_once() {
		two_writers_finish(
			"emulate zsh -c '{ printf %{EXTRA}s \"\" & read -r go; printf %0{BUILTIN}d 0; wait; } \
			 >&1 >/dev/null'",
			true,
			&[(b' ', EXTRA), (b'0', BUILTIN)],
		);
	}

	// Failure mode: the same with the same bytes from both vprocs. Writers
	// told apart by their bytes would take one write for the other.
	#[test]
	fn two_builtins_writing_the_same_bytes_through_one_tee_write_them_once_each() {
		two_writers_finish(
			"emulate zsh -c '{ printf %0{EXTRA}d 0 & read -r go; printf %0{BUILTIN}d 0; wait; } >&1 \
			 >/dev/null'",
			true,
			&[(b'0', EXTRA + BUILTIN)],
		);
	}

	// Failure mode: a fast-path builtin (`write_now`, bash mode) wrote its
	// first bytes through a tee with no key and the rest with its vproc's
	// key, so the tee kept two progresses for one write and wrote the first
	// bytes again. The tee is the shell's stdout, made in zsh mode by `exec`.
	#[test]
	fn fast_path_builtins_through_a_tee_on_the_shells_stdout_write_their_bytes_once() {
		two_writers_finish(
			"emulate zsh -c 'exec >&1 >/dev/null'\n{ printf %{EXTRA}s '' & read -r go; printf \
			 %0{BUILTIN}d 0; wait; }",
			false,
			&[(b' ', EXTRA), (b'0', BUILTIN)],
		);
	}

	// Failure mode: two vprocs' diagnostics (`flush_out`) through a tee
	// with no key were one writer to it: each went on from where the other
	// stopped. The tee is the shell's stderr, made in zsh mode by `exec`;
	// each diagnostic names a command of `EXTRA` '0's or `BUILTIN` 'Z's.
	#[test]
	fn two_vprocs_diagnostics_through_a_tee_on_the_shells_stderr_are_each_written_once() {
		let got = writers_read(
			"emulate zsh -c 'exec 2>&1 2>/dev/null'\np=$(printf %0{EXTRA}d 0)\nq=$(printf \
			 %0{BUILTIN}d 0)\n{ \"$p\" & read -r go; \"${q//0/Z}\"; wait; }",
			false,
			2,
		);
		let count = |c: u8| got.iter().find(|&&(b, _)| b == c).map_or(0, |&(_, n)| n);
		assert_eq!(
			(count(b'0'), count(b'Z'), count(b'\n')),
			(EXTRA, BUILTIN, 2),
			"stdout (byte, count): {got:?}"
		);
	}

	// Failure mode (review of #111 at 2fb85be7): with the tee keeping a
	// writer's progress after its write ended, the vproc's next write
	// through the tee started at the old offsets and was lost.
	#[test]
	fn one_vproc_writing_twice_through_one_tee_writes_both() {
		let got = writers_read(
			"emulate zsh -c '{ printf %{EXTRA}s \"\"; printf %0{BUILTIN}d 0; } >&1 >/dev/null'",
			true,
			1,
		);
		assert_eq!(got, [(b' ', EXTRA), (b'0', BUILTIN)]);
	}

	// Failure mode: two host callouts (`timeout`'s diagnostics, through
	// `ShellApi::write`) in two vprocs wrote through one tee with no key and
	// were one writer to it. The tee is the shell's stderr; the diagnostics
	// name intervals of `EXTRA` 'Y's and `BUILTIN` 'Z's.
	#[test]
	fn two_callouts_through_a_tee_on_the_shells_stderr_write_their_bytes_once() {
		let got = writers_read(
			"emulate zsh -c 'exec 2>&1 2>/dev/null'\np=$(printf %0{EXTRA}d 0)\nq=$(printf \
			 %0{BUILTIN}d 0)\n{ timeout \"${p//0/Y}\" true & read -r go; timeout \"${q//0/Z}\" true; \
			 wait; }",
			false,
			2,
		);
		let count = |c: u8| got.iter().find(|&&(b, _)| b == c).map_or(0, |&(_, n)| n);
		assert_eq!(
			(count(b'Y'), count(b'Z'), count(b'\n')),
			(EXTRA, BUILTIN, 2),
			"stdout (byte, count): {got:?}"
		);
	}

	// Failure mode: two zsh `syswrite`s in two vprocs wrote through one tee
	// with no key and were one writer to it.
	#[test]
	fn two_syswrites_through_one_tee_write_their_bytes_once() {
		two_writers_finish(
			"emulate zsh -c 'zmodload zsh/system; a=$(printf %{EXTRA}s \"\"); b=$(printf \
			 %0{BUILTIN}d 0); { syswrite -o 1 \"$a\" & read -r go; syswrite -o 1 \"$b\"; wait; } >&1 \
			 >/dev/null'",
			false,
			&[(b' ', EXTRA), (b'0', BUILTIN)],
		);
	}

	/// A step a trap test takes beside its run ([`run_with_steps`]).
	enum Step {
		/// Wait until `n` polls of the run's stdout have waited for room.
		Pending(usize),
		/// Write this line to the run's stdin.
		Send(&'static str),
		/// Wait for this line on the run's stderr.
		Line(&'static str),
		/// Cancel the run, as the host does.
		Cancel,
		/// Wait until a `CHLD` or `WINCH` trap of this run's shell has waited
		/// for a write since the run began (its engine's test-only count,
		/// [`Engine::traps_held`]).
		Held,
		/// Wait until `n` more polls of the run's stdout have waited for room
		/// than when this step began.
		PendingMore(usize),
	}

	/// What [`run_with_steps`] saw.
	struct Stepped {
		stdout:    Vec<u8>,
		status:    i32,
		cancelled: bool,
		/// Whether a `CHLD` or `WINCH` trap of the run's shell waited for a
		/// write meanwhile.
		held:      bool,
	}

	/// Run `command` with stdin, stdout and stderr on pipes and take `steps`
	/// in order beside it; nothing reads stdout until they are done. Then,
	/// with `drain`, a reader drains stdout 4 KiB at a time; without it,
	/// stdout is read only once the run has ended. A step the run ends
	/// before is skipped. The run must end within [`STUCK`].
	fn run_with_steps(command: &str, steps: &'static [Step], drain: bool) -> Stepped {
		use std::{
			io::{BufRead, Write},
			os::fd::{AsRawFd, OwnedFd},
		};
		let (mut out_r, out_w) = io::pipe().unwrap();
		let (in_r, mut in_w) = io::pipe().unwrap();
		let (err_r, err_w) = io::pipe().unwrap();
		let out_w = std::fs::File::from(OwnedFd::from(out_w));
		let fd = out_w.as_raw_fd();
		let waited = crate::sys::pending_polls(fd);
		let runtime = own_runtime();
		let mut session = runtime.block_on(async { session() });
		// The count of this session's shell alone: tests in one process
		// run shells side by side.
		let engine = session.engine();
		let held = engine.traps_held().load(Ordering::SeqCst);
		let cancel = CancellationToken::new();
		let ended = Arc::new(AtomicBool::new(false));
		let reached = Arc::new(AtomicU8::new(0));
		let reader = {
			let (cancel, ended, reached) = (cancel.clone(), Arc::clone(&ended), Arc::clone(&reached));
			let (engine, held_then) = (Arc::clone(&engine), held);
			std::thread::spawn(move || {
				let mut lines = std::io::BufReader::new(err_r).lines();
				for step in steps {
					let done = match step {
						Step::Pending(n) => {
							while crate::sys::pending_polls(fd) < waited + n
								&& !ended.load(Ordering::SeqCst)
							{
								std::thread::sleep(Duration::from_millis(1));
							}
							crate::sys::pending_polls(fd) >= waited + n
						},
						Step::Send(line) => in_w.write_all(format!("{line}\n").as_bytes()).is_ok(),
						Step::Line(want) => lines.any(|line| line.is_ok_and(|line| line == *want)),
						Step::Cancel => {
							cancel.cancel();
							true
						},
						Step::PendingMore(n) => {
							let from = crate::sys::pending_polls(fd);
							while crate::sys::pending_polls(fd) < from + n && !ended.load(Ordering::SeqCst)
							{
								std::thread::sleep(Duration::from_millis(1));
							}
							crate::sys::pending_polls(fd) >= from + n
						},
						Step::Held => {
							let now = || engine.traps_held().load(Ordering::SeqCst);
							while now() <= held_then && !ended.load(Ordering::SeqCst) {
								std::thread::sleep(Duration::from_millis(1));
							}
							now() > held_then
						},
					};
					if !done {
						break;
					}
					reached.fetch_add(1, Ordering::SeqCst);
				}
				while !drain && !ended.load(Ordering::SeqCst) {
					std::thread::sleep(Duration::from_millis(1));
				}
				let mut got = Vec::new();
				let mut buf = vec![0u8; 4 << 10];
				loop {
					let n = out_r.read(&mut buf).unwrap();
					if n == 0 {
						break;
					}
					got.extend_from_slice(&buf[..n]);
					if drain {
						std::thread::sleep(Duration::from_micros(500));
					}
				}
				got
			})
		};
		let ended_run = runtime.block_on(async {
			let stdio = RunStdio {
				stdin:  Some(std::fs::File::from(OwnedFd::from(in_r))),
				stdout: Some(out_w),
				stderr: Some(std::fs::File::from(OwnedFd::from(err_w))),
			};
			tokio::time::timeout(STUCK, session.run_with(RunOptions::new(command), stdio, cancel))
				.await
		});
		drop(session);
		ended.store(true, Ordering::SeqCst);
		let Ok(outcome) = ended_run else {
			runtime.shutdown_background();
			panic!(
				"`{command}` never ended; it reached {} of {} steps",
				reached.load(Ordering::SeqCst),
				steps.len()
			);
		};
		let outcome = outcome.unwrap();
		Stepped {
			stdout:    reader.join().unwrap(),
			status:    outcome.status,
			cancelled: outcome.cancelled,
			held:      engine.traps_held().load(Ordering::SeqCst) > held,
		}
	}

	/// `got` is `zeros` '0's, then `ts` 'T's.
	#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
	fn zeros_then_ts(got: &[u8], zeros: usize, ts: usize) {
		let count = |c: u8| got.iter().filter(|&&b| b == c).count();
		let first_t = got.iter().position(|&b| b == b'T');
		assert_eq!(
			(count(b'0'), count(b'T'), got.len(), first_t),
			(zeros, ts, zeros + ts, Some(zeros)),
			"('0's, 'T's, bytes, first 'T' at)"
		);
	}

	/// `got` is `zeros` '0's with `marker` once among them, after the first
	/// and before the last: a trap's bytes in the middle of a command's,
	/// each of the command's bytes once.
	#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
	fn marker_mid_write(got: &[u8], zeros: usize, marker: &[u8]) {
		let at = got.windows(marker.len()).position(|w| w == marker);
		let zeros_got = got.iter().filter(|&&b| b == b'0').count();
		assert_eq!(
			(zeros_got, got.len(), at.is_some_and(|at| at > 0 && at < zeros)),
			(zeros, zeros + marker.len(), true),
			"('0's, bytes, marker inside the '0's); marker at {at:?}"
		);
	}

	/// Bytes a write through a zsh multios tee to the run's stdout writes so
	/// that it waits: more than the pipe (64 KiB) and the tee's queue
	/// ([`TEE_HOLD`](crate::bash::TEE_HOLD)) take together.
	/// The tee tests below wrote 131,072 bytes for #111's tee, which took
	/// none of a write it could not pass on; the release's queued tee takes
	/// up to its hold, so 131,072 bytes never waited there. A larger hold
	/// fails this at compile time.
	const TEE_WAITS: usize = 262_144;
	const _: () = assert!(TEE_WAITS > (64 << 10) + crate::bash::TEE_HOLD);

	const CHLD_STEPS: &[Step] = &[Step::Pending(1), Step::Send("go"), Step::Line("done")];

	// Failure mode (review of #111 at 2fb85be7): a `CHLD` trap started while
	// `printf`'s write through a tee waited for room, under the same key, so
	// the tee took `printf`'s progress as the trap's: stdout held 196,608
	// '0's and no 'T'. bash 5.2/5.3 and zsh 5.9 run a `CHLD` trap after the
	// command: 131,072 '0's, then the 10 'T's.
	#[test]
	fn a_chld_trap_owed_during_a_write_through_a_tee_runs_after_it() {
		let run = run_with_steps(
			"emulate zsh -c 'exec >&1 >/dev/null'\nexec 3<&0\ntrap 'printf %s TTTTTTTTTT' CHLD\n{ \
			 read -r go <&3; echo done >&2; } &\nprintf %0262144d 0\ns=$?\nwait\nexit $s",
			CHLD_STEPS,
			true,
		);
		assert_eq!(run.status, 0);
		zeros_then_ts(&run.stdout, TEE_WAITS, 10);
		assert!(run.held, "the trap was not owed while the write waited");
	}

	// Failure mode: as above through a plain pipe: the trap's bytes came in
	// the middle of `printf`'s, where bash and zsh write them after.
	#[test]
	fn a_chld_trap_owed_during_a_write_through_a_pipe_runs_after_it() {
		let run = run_with_steps(
			"exec 3<&0\ntrap 'printf %s TTTTTTTTTT' CHLD\n{ read -r go <&3; echo done >&2; } \
			 &\nprintf %0131072d 0\ns=$?\nwait\nexit $s",
			CHLD_STEPS,
			true,
		);
		assert_eq!(run.status, 0);
		zeros_then_ts(&run.stdout, 131_072, 10);
		assert!(run.held, "the trap was not owed while the write waited");
	}

	// Failure mode (#111 at 5cf0e434, the whole library in one process):
	// `Step::Held` and `Stepped::held` read one count for the whole process,
	// so another test's shell could end the step before this run's `CHLD`
	// trap had waited. The reader then drained too early, and
	// `a_chld_trap_owed_while_another_trap_writes_runs_after_that_write`
	// found the 'C's after the last '0'. Each session counts its own shell's.
	#[test]
	fn a_held_chld_trap_counts_in_its_own_session_only() {
		let runtime = own_runtime();
		let other = runtime.block_on(async { session() });
		let run = run_with_steps(
			"exec 3<&0\ntrap 'printf %s TTTTTTTTTT' CHLD\n{ read -r go <&3; echo done >&2; } \
			 &\nprintf %0131072d 0\ns=$?\nwait\nexit $s",
			CHLD_STEPS,
			true,
		);
		assert!(run.held, "the run's own shell held no trap");
		assert_eq!(
			other.engine().traps_held().load(Ordering::SeqCst),
			0,
			"another session counted the run's held trap"
		);
	}

	/// `printf` waits, the job sends the signal, and the trap's own write
	/// waits on the same full pipe before the reader drains.
	const SIGNAL_STEPS: &[Step] =
		&[Step::Pending(1), Step::Send("go"), Step::Line("done"), Step::Pending(2)];

	// Failure mode (review of #111 at 2fb85be7): a USR1 trap ran while
	// `printf`'s write through a tee waited, under the same key: the trap's
	// bytes counted as written and were lost, and `printf` wrote its first
	// 65,536 bytes again. The trap now runs at once (as in bash and zsh)
	// under a key of its own; its write waits on the same full pipe and
	// ends once the reader drains, and `printf`'s write then goes on. bash
	// and zsh instead fail `printf` with a write error and drop its rest.
	#[test]
	fn a_usr1_trap_during_a_write_through_a_tee_runs_at_once_and_the_write_goes_on() {
		let run = run_with_steps(
			"emulate zsh -c 'exec >&1 >/dev/null'\nexec 3<&0\ntrap 'printf %s TTTTTTTTTT' USR1\n{ \
			 read -r go <&3; kill -USR1 $$; echo done >&2; } &\nprintf %0262144d 0\ns=$?\nwait\nexit \
			 $s",
			SIGNAL_STEPS,
			true,
		);
		assert_eq!(run.status, 0);
		marker_mid_write(&run.stdout, TEE_WAITS, b"TTTTTTTTTT");
	}

	// The same through a plain pipe (no tee keeps progress there; it passed
	// before the trap keys too, and stays as a guard).
	#[test]
	fn a_usr1_trap_during_a_write_through_a_pipe_runs_at_once_and_the_write_goes_on() {
		let run = run_with_steps(
			"exec 3<&0\ntrap 'printf %s TTTTTTTTTT' USR1\n{ read -r go <&3; kill -USR1 $$; echo done \
			 >&2; } &\nprintf %0131072d 0\ns=$?\nwait\nexit $s",
			SIGNAL_STEPS,
			true,
		);
		assert_eq!(run.status, 0);
		marker_mid_write(&run.stdout, 131_072, b"TTTTTTTTTT");
	}

	// A trap that exits ends a shell whose write waits, at once, as bash
	// 5.2/5.3 do (`trap 'exit 42' TERM`): nothing drains stdout until the
	// run has ended.
	#[test]
	#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
	fn an_exit_trap_ends_a_shell_whose_write_waits() {
		let run = run_with_steps(
			"exec 3<&0\ntrap 'exit 42' TERM\n{ read -r go <&3; kill -TERM $$; echo done >&2; } \
			 &\nprintf %0131072d 0\necho never",
			CHLD_STEPS,
			false,
		);
		assert_eq!(run.status, 42);
		let zeros = run.stdout.iter().filter(|&&b| b == b'0').count();
		assert!(
			zeros < 131_072 && zeros == run.stdout.len(),
			"{zeros} '0's of {} bytes",
			run.stdout.len()
		);
	}

	// Failure mode: nested traps (USR2 while USR1's trap waits to write)
	// each wrote under the key of what they interrupted. Each trap has its
	// own key and puts the interrupted one back when it ends: USR2's bytes,
	// then USR1's, then the rest of `printf`'s, each once.
	#[test]
	fn nested_traps_during_a_write_through_a_tee_each_write_once() {
		let run = run_with_steps(
			"emulate zsh -c 'exec >&1 >/dev/null'\nexec 3<&0\ntrap 'printf %s UUUUUUUUUU' USR1\ntrap \
			 'printf %s VVVVVVVVVV' USR2\n{ read -r go <&3; kill -USR1 $$; read -r go <&3; kill \
			 -USR2 $$; echo done >&2; } &\nprintf %0262144d 0\ns=$?\nwait\nexit $s",
			&[
				Step::Pending(1),
				Step::Send("go"),
				Step::Pending(2),
				Step::Send("go"),
				Step::Line("done"),
				Step::Pending(3),
			],
			true,
		);
		assert_eq!(run.status, 0);
		marker_mid_write(&run.stdout, TEE_WAITS, b"VVVVVVVVVVUUUUUUUUUU");
	}

	// Failure mode: the host's cancellation starts the TERM trap through
	// the same path: its bytes were taken as `printf`'s progress and lost.
	// The trap is the run's last action: `printf`'s rest is not written.
	#[test]
	#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
	fn a_cancellation_trap_during_a_write_through_a_tee_writes_its_bytes() {
		let run = run_with_steps(
			"emulate zsh -c 'exec >&1 >/dev/null'\ntrap 'printf %s TTTTTTTTTT' TERM\nprintf \
			 %0262144d 0\necho never",
			&[Step::Pending(1), Step::Cancel, Step::Pending(2)],
			true,
		);
		assert!(run.cancelled);
		let zeros = run.stdout.iter().filter(|&&b| b == b'0').count();
		assert!(zeros > 0 && zeros < TEE_WAITS, "{zeros} '0's");
		zeros_then_ts(&run.stdout, zeros, 10);
	}

	/// `printf` waits, the job sends WINCH and says `done`, and its trap
	/// waits for `printf`'s write (`Vproc::holds_trap`).
	const WINCH_STEPS: &[Step] =
		&[Step::Pending(1), Step::Send("go"), Step::Line("done"), Step::Held];

	/// A script whose WINCH trap runs `action` while `printf %0{zeros}d 0`
	/// waits; the job sends WINCH on `go`.
	fn winch_script(prefix: &str, action: &str, zeros: usize) -> String {
		format!(
			"{prefix}exec 3<&0\ntrap '{action}' WINCH\n{{ read -r go <&3; kill -WINCH $$; echo done \
			 >&2; }} &\nprintf %0{zeros}d 0\ns=$?\nwait\nexit $s"
		)
	}

	// Failure mode (review of #111 at 5cf0e434, from #157's review): a WINCH
	// trap ran at once while `printf`'s write waited, and its bytes came at
	// 65,536, inside `printf`'s. bash 5.2.21 and 5.3.20 (interactive and
	// `-c`) and zsh 5.9 (interactive and `-c`, to a FIFO and through a
	// multios) run a WINCH trap once the write ends, as a `CHLD` trap:
	// 131,072 '0's, then the 'T's. The trap waits; the run does not end
	// before it runs.
	#[test]
	fn a_winch_trap_during_a_write_through_a_tee_runs_after_it() {
		let run = run_with_steps(
			&winch_script("emulate zsh -c 'exec >&1 >/dev/null'\n", "printf %s TTTTTTTTTT", TEE_WAITS),
			WINCH_STEPS,
			true,
		);
		assert_eq!(run.status, 0);
		zeros_then_ts(&run.stdout, TEE_WAITS, 10);
		assert!(run.held, "the trap did not wait for the write");
	}

	// The same through a plain pipe, in zsh mode: the trap waits there too.
	#[test]
	fn a_winch_trap_during_a_write_in_zsh_mode_runs_after_it() {
		let run = run_with_steps(
			"emulate zsh -c 'exec 3<&0; trap \"printf %s TTTTTTTTTT\" WINCH; { read -r go <&3; kill \
			 -WINCH $$; echo done >&2; } & printf %0131072d 0; s=$?; wait; exit $s'",
			WINCH_STEPS,
			true,
		);
		assert_eq!(run.status, 0);
		zeros_then_ts(&run.stdout, 131_072, 10);
		assert!(run.held, "the trap did not wait for the write");
	}

	// A held WINCH trap that writes more than the pipe holds (204,800
	// spaces): it runs once `printf`'s write ends and its own write then
	// waits in turn; no deadlock, and the order is kept.
	#[test]
	#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
	fn a_held_winch_trap_writing_more_than_the_pipe_holds_comes_after_the_write() {
		let run =
			run_with_steps(&winch_script("", "printf %204800s \"\"", 131_072), WINCH_STEPS, true);
		assert_eq!(run.status, 0);
		let count = |c: u8| run.stdout.iter().filter(|&&b| b == c).count();
		let first_space = run.stdout.iter().position(|&b| b == b' ');
		assert_eq!(
			(count(b'0'), count(b' '), run.stdout.len(), first_space),
			(131_072, 204_800, 335_872, Some(131_072)),
			"('0's, spaces, bytes, first space at)"
		);
		assert!(run.held, "the trap did not wait for the write");
	}

	// The run is cancelled while `printf` waits and the WINCH trap is held.
	// The cancellation's TERM trap is the run's last action and drops
	// `printf`'s rest; the held WINCH trap is no longer behind a write and
	// runs too. Each trap's bytes come once, after the '0's written.
	#[test]
	#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
	fn a_held_winch_trap_of_a_cancelled_run_writes_its_bytes_once() {
		let run = run_with_steps(
			&winch_script("trap 'printf %s XXXXXXXXXX' TERM\n", "printf %s TTTTTTTTTT", 131_072),
			&[Step::Pending(1), Step::Send("go"), Step::Line("done"), Step::Held, Step::Cancel],
			true,
		);
		assert!(run.cancelled);
		let zeros = run.stdout.iter().take_while(|&&b| b == b'0').count();
		let tail = &run.stdout[zeros..];
		let count = |c: u8| tail.iter().filter(|&&b| b == c).count();
		assert!(zeros > 0 && zeros < 131_072, "{zeros} '0's first");
		assert_eq!(
			(count(b'X'), count(b'T'), tail.len()),
			(10, 10, 20),
			"after the '0's: {:?}",
			String::from_utf8_lossy(tail)
		);
		assert!(run.held, "the trap did not wait for the write");
	}

	/// `got` is some '0's (more than none, fewer than `whole`), then exactly
	/// `tail`: a write dropped part way, then the writes after it, whole.
	fn some_zeros_then(got: &[u8], whole: usize, tail: &[u8]) {
		let zeros = got.len().saturating_sub(tail.len());
		let head_is_zeros = got[..zeros].iter().all(|&b| b == b'0');
		assert!(
			head_is_zeros && got.ends_with(tail) && zeros > 0 && zeros < whole,
			"{zeros} bytes before the tail ({}), ending {:?}",
			if head_is_zeros {
				"all '0's"
			} else {
				"not all '0's"
			},
			String::from_utf8_lossy(&got[got.len().saturating_sub(tail.len() + 8)..])
		);
	}

	// Failure mode (review of #111 at 5773e4ed): `return` in a trap also
	// dropped the command the trap interrupted, `printf`, whose write
	// through a tee waited. The tee kept that write's progress under the
	// shell's write key, so the next write, `printf %s AFTER7`, started at
	// those offsets and was lost; at 2fb85be7 the trap's bytes were lost
	// instead. bash 5.2 keeps both. The dropped command takes the key with
	// it: stdout holds the '0's written before the trap, its 10 'T's, then
	// AFTER7.
	#[test]
	fn a_write_a_trap_return_drops_leaves_the_next_write_whole() {
		let run = run_with_steps(
			"emulate zsh -c 'exec >&1 >/dev/null'\nexec 3<&0\nf() { printf %0262144d 0; printf %s \
			 NEVER; }\ntrap 'printf %s TTTTTTTTTT; return 7' USR1\n{ read -r go <&3; kill -USR1 $$; \
			 echo done >&2; } &\nf\ns=$?\nprintf %s AFTER$s\nwait",
			SIGNAL_STEPS,
			true,
		);
		assert_eq!(run.status, 0);
		some_zeros_then(&run.stdout, TEE_WAITS, b"TTTTTTTTTTAFTER7");
	}

	// Failure mode (review of #111 at 5773e4ed): a `CHLD` trap owed while a
	// USR1 trap wrote waited only while the vproc was parked on a write, and
	// the USR1 trap had unparked it: the `CHLD` trap's 'C's came in the
	// middle of the USR1 trap's write. A `CHLD` trap waits for the write of
	// the command it would interrupt, here the USR1 trap's `printf`, and then
	// runs inside that trap: the 'T's inside `printf`'s '0's, the 'C's right
	// after them. The job ends once the USR1 trap has told it to, just before
	// the trap's own write, and the reader drains only once the job's `CHLD`
	// has waited for that write. bash 5.2.21 (10 of 10) and 5.3.20 (9 of
	// 10) write the 'T's and then the 'C's after the 65,536 '0's that fit,
	// and drop `printf`'s rest (status 1); zsh 5.9 the same (10 of 10,
	// status 0). Here the rest of the '0's follows. At a25f15f0 the 'C's came
	// after the last '0': round 8 held the trap for the write the USR1 trap
	// had interrupted too.
	#[test]
	#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
	fn a_chld_trap_owed_while_another_trap_writes_runs_after_that_write() {
		use std::os::unix::ffi::OsStrExt;
		let dir = tempfile::tempdir().unwrap();
		let fifo = dir.path().join("told");
		let path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
		// SAFETY: a valid C string.
		assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0, "mkfifo");
		let command = format!(
			"emulate zsh -c 'exec >&1 >/dev/null'\nexec 3<&0\nexec 5<>{}\ntrap 'echo x >&5; printf \
			 %s TTTTTTTTTT' USR1\ntrap 'printf %s CCCCCCCCCC' CHLD\n{{ read -r go <&3; kill -USR1 \
			 $$; echo done >&2; read -r x <&5; }} &\nprintf %0262144d 0\ns=$?\nwait\nexit $s",
			fifo.display()
		);
		// The reader drains only once the job's `CHLD` has waited for the
		// USR1 trap's write.
		let run = run_with_steps(
			&command,
			&[Step::Pending(1), Step::Send("go"), Step::Line("done"), Step::Pending(2), Step::Held],
			true,
		);
		assert_eq!(run.status, 0);
		let got = &run.stdout;
		let ts = got.windows(10).position(|w| w == b"TTTTTTTTTT");
		let cs = got.windows(10).position(|w| w == b"CCCCCCCCCC");
		let last_zero = got.iter().rposition(|&b| b == b'0');
		let count = |c: u8| got.iter().filter(|&&b| b == c).count();
		assert_eq!(
			(count(b'0'), count(b'T'), count(b'C'), got.len()),
			(TEE_WAITS, 10, 10, TEE_WAITS + 20),
			"('0's, 'T's, 'C's, bytes)"
		);
		assert!(
			ts.is_some_and(|ts| {
				ts > 0 && last_zero.is_some_and(|z| ts < z) && cs.is_some_and(|cs| cs == ts + 10)
			}),
			"the 'T's at {ts:?}, the 'C's at {cs:?}, the last '0' at {last_zero:?}: the 'T's inside \
			 the '0's, the 'C's right after them"
		);
		assert!(run.held, "the CHLD trap did not wait for a write");
	}

	// Failure mode (review of #111 at 5cf0e434, the reviewer's script): a
	// `CHLD` trap waits for the write of the command it would interrupt when
	// the vproc is not parked on it too. A job sends USR1 and ends while
	// `printf`'s write waits; the USR1 trap's own write waits, and then the
	// job ends, its `CHLD` owed. A second job's USR1 then unparks the vproc: its
	// trap cannot start inside the first, so the vproc goes back to the USR1
	// trap's op, which is still part way (`FrameFlags::write_parked`). With the
	// hold only while parked (round 8's), the `CHLD` trap ran there, its 'C's at
	// byte 65,536, before any of the trap's spaces. It waits for that write and
	// runs when the first trap's write ends: the 'C's right after the first
	// trap's 100,000 spaces, as bash 5.2.21 and 5.3.20 (`0*65536 ' '*100000
	// C*20`, `printf`'s rest dropped) and zsh 5.9 (`0*73728 ' '*100000 C*20
	// ' '*100000`) write them.
	#[test]
	#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
	fn a_chld_trap_waits_for_a_traps_write_a_second_signal_unparked() {
		let dir = tempfile::tempdir().unwrap();
		let first_done = dir.path().join("first-done");
		let command = format!(
			"exec 3<&0\ntrap 'echo in-trap >&2; printf %100000s \"\"' USR1\ntrap 'printf %s \
			 CCCCCCCCCC' CHLD\n{{ read -r go <&3; kill -USR1 $$; echo done1 >&2; read -r go <&3; : > \
			 {f}; }} &\n{{ until [ -e {f} ]; do sleep 0.01; done; read -r go <&3; kill -USR1 $$; \
			 echo done2 >&2; }} &\nprintf %0131072d 0\nwait",
			f = first_done.display()
		);
		// The first job ends only once the USR1 trap's own write waits (the
		// first poll of stdout that waits after the trap began); the second
		// reads its line only once the first has ended and its `CHLD` waits
		// for that write.
		let run = run_with_steps(
			&command,
			&[
				Step::Pending(1),
				Step::Send("go"),
				Step::Line("in-trap"),
				Step::PendingMore(1),
				Step::Send("go"),
				Step::Held,
				Step::Send("go"),
				Step::Line("done2"),
			],
			true,
		);
		assert_eq!(run.status, 0);
		let got = &run.stdout;
		let count = |c: u8| got.iter().filter(|&&b| b == c).count();
		let zeros = got.iter().position(|&b| b != b'0').unwrap_or(got.len());
		let first_c = got.iter().position(|&b| b == b'C');
		assert_eq!(
			(count(b'0'), count(b' '), count(b'C')),
			(131_072, 200_000, 20),
			"('0's, spaces, 'C's)"
		);
		let spaces_next = got
			.get(zeros..zeros + 100_000)
			.is_some_and(|s| s.iter().all(|&b| b == b' '));
		assert!(
			zeros > 0 && spaces_next && first_c == Some(zeros + 100_000),
			"{zeros} '0's first; the first 'C' at {first_c:?}: right after the first trap's spaces"
		);
	}

	// Failure mode (review of #111 at a25f15f0): a `CHLD` trap waited while
	// any write of the vproc was part way, the one a USR1 trap had
	// interrupted too, and the USR1 trap waited for the `CHLD` trap's work:
	// the run never ended (at 5773e4ed it ended in under 60 ms). bash 5.2/5.3
	// and zsh 5.9 run the `CHLD` trap inside the USR1 trap, and so does this
	// shell: a `CHLD` trap waits only for the write of the command it would
	// interrupt. The USR1 trap's 'T' comes inside `printf`'s '0's.
	#[test]
	fn a_trap_that_waits_for_the_chld_traps_work_ends() {
		let run = run_with_steps(
			"exec 3<&0\ntrap 'c=1' CHLD\ntrap 'until [ -n \"$c\" ]; do sleep 0.1; done; printf %s T' \
			 USR1\n{ read -r go <&3; kill -USR1 $$; echo done >&2; } &\nprintf %0131072d 0\nwait",
			SIGNAL_STEPS,
			true,
		);
		assert_eq!(run.status, 0);
		marker_mid_write(&run.stdout, 131_072, b"T");
	}

	// Failure mode (review of #111 at a25f15f0): a TERM trap that kills a
	// job and waits for a `CHLD` trap to count it, while `printf`'s write
	// through a tee waited, waited all its 30 rounds: the `CHLD` trap waited
	// for the write the TERM trap had interrupted. bash 5.2/5.3 count the job
	// after 1 or 2 rounds of `read -t 0.1`, zsh 5.9 at once (0 rounds). The
	// `CHLD` trap runs inside the TERM trap: `T<rounds>X` after the '0's
	// written, fewer than 30 rounds, and the trap's `exit 3`.
	#[test]
	fn a_cleanup_trap_that_waits_for_a_chld_count_ends() {
		let run = run_with_steps(
			"emulate zsh -c 'exec >&1 >/dev/null'\nexec 3<&0\nn=0\ntrap 'n=$((n+1))' CHLD\nsleep 100 \
			 &\nsp=$!\n{ read -r go <&3; kill -TERM $$; echo done >&2; } &\ntrap 'm=$n; kill $sp; \
			 r=0; until [ $n -gt $m ] || [ $r -ge 30 ]; do read -r -t 0.1 _ <&3; r=$((r+1)); done; \
			 printf %s T${r}X; exit 3' TERM\nprintf %0262144d 0\necho never",
			CHLD_STEPS,
			true,
		);
		assert_eq!(run.status, 3);
		let got = &run.stdout;
		let zeros = got.iter().position(|&b| b != b'0').unwrap_or(got.len());
		let tail = String::from_utf8_lossy(&got[zeros..]).into_owned();
		let rounds = tail
			.strip_prefix('T')
			.and_then(|t| t.strip_suffix('X'))
			.and_then(|r| r.parse::<u32>().ok());
		assert!(zeros > 0 && zeros < TEE_WAITS, "{zeros} '0's, then {tail:?}");
		assert!(rounds.is_some_and(|r| r < 30), "the TERM trap wrote {tail:?}: rounds < 30");
	}

	/// Three runs of one session: the first makes fd 3 a tee of a FIFO and
	/// `file` (`exec 3>fifo 3>file`; the tee outlives the run), the second
	/// runs `second(reader)`, whose write through the tee fills the FIFO and
	/// waits, and is cancelled (with `cancel`; else it ends the shell
	/// itself), and the third runs `printf %s AFTER >&3`. `second` gets the
	/// FIFO's reader to size its write by ([`fifo_room`]). Returns what the
	/// FIFO's reader got, ending with `AFTER` unless that was lost, and the
	/// second run's status.
	///
	/// The runs go on a thread of their own, which the test waits for with a
	/// bound (twice [`STUCK`]): a write through the tee that blocks the
	/// shell's runtime thread in `write(2)` (gVisor, without the release's
	/// private pipe writer) stops this runtime's timers too, and the test
	/// would never end, nor a library run in one process. Past the bound
	/// the test fails; the stuck thread ends with the process.
	fn drop_a_write_through_a_fifo_tee(
		second: impl FnOnce(&std::fs::File) -> String + Send + 'static,
		file: &std::path::Path,
		cancel: bool,
	) -> (Vec<u8>, i32) {
		let file = file.to_owned();
		let (done, ended) = std::sync::mpsc::channel();
		std::thread::spawn(move || {
			let runs = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
				three_runs_through_a_fifo_tee(second, &file, cancel)
			}));
			let _ = done.send(runs);
		});
		match ended.recv_timeout(2 * STUCK) {
			Ok(Ok(got)) => got,
			Ok(Err(panicked)) => std::panic::resume_unwind(panicked),
			Err(ended) => panic!(
				"the runs through the tee did not end within {:?} ({ended}); likely a write blocking \
				 the shell's thread",
				2 * STUCK
			),
		}
	}

	/// [`drop_a_write_through_a_fifo_tee`]'s three runs.
	fn three_runs_through_a_fifo_tee(
		second: impl FnOnce(&std::fs::File) -> String,
		file: &std::path::Path,
		cancel: bool,
	) -> (Vec<u8>, i32) {
		use std::os::{fd::AsRawFd, unix::ffi::OsStrExt};
		let dir = tempfile::tempdir().unwrap();
		let fifo = dir.path().join("tee-fifo");
		let path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
		// SAFETY: a valid C string.
		assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0, "mkfifo");
		let null = |write: bool| {
			std::fs::OpenOptions::new()
				.read(!write)
				.write(write)
				.open("/dev/null")
				.unwrap()
		};
		let stdio = || RunStdio {
			stdin:  Some(null(false)),
			stdout: Some(null(true)),
			stderr: Some(null(true)),
		};
		let queued = |reader: &std::fs::File| {
			let mut n: libc::c_int = 0;
			// SAFETY: FIONREAD writes one int.
			unsafe { libc::ioctl(reader.as_raw_fd(), libc::FIONREAD, &mut n) };
			usize::try_from(n).unwrap_or(0)
		};
		// The reader's open waits for the shell's.
		let opening = {
			let fifo = fifo.clone();
			std::thread::spawn(move || std::fs::File::open(fifo))
		};
		let runtime = own_runtime();
		runtime.block_on(async {
			let mut session = session();
			let made = format!("emulate zsh -c 'exec 3>{} 3>{}'", fifo.display(), file.display());
			let made = tokio::time::timeout(
				STUCK,
				session.run_with(RunOptions::new(made.as_str()), stdio(), CancellationToken::new()),
			)
			.await;
			assert_eq!(made.expect("the tee was made").unwrap().status, 0);
			let mut reader = opening.join().unwrap().unwrap();
			let second = second(&reader);
			// SAFETY: fcntl on a descriptor this test owns.
			unsafe {
				let flags = libc::fcntl(reader.as_raw_fd(), libc::F_GETFL);
				libc::fcntl(reader.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
			}
			// The second run's write fills the FIFO and waits for room; then the
			// run is cancelled, or ends the shell itself.
			let token = CancellationToken::new();
			let canceller = cancel.then(|| {
				let token = token.clone();
				let probe = reader.try_clone().unwrap();
				std::thread::spawn(move || {
					let start = std::time::Instant::now();
					while queued(&probe) < 4096 && start.elapsed() < STUCK {
						std::thread::sleep(Duration::from_millis(5));
					}
					std::thread::sleep(Duration::from_millis(300));
					token.cancel();
				})
			});
			let cancelled = tokio::time::timeout(
				STUCK,
				session.run_with(RunOptions::new(second.as_str()), stdio(), token),
			)
			.await;
			if let Some(canceller) = canceller {
				canceller.join().unwrap();
			}
			let cancelled = cancelled.expect("the run ended").unwrap();
			assert_eq!(cancelled.cancelled, cancel, "(the run was cancelled)");
			// The third run's write waits until the reader drains.
			let draining = std::thread::spawn(move || {
				let mut got = Vec::new();
				let mut buf = vec![0u8; 4 << 10];
				let start = std::time::Instant::now();
				while !got.ends_with(b"AFTER") && start.elapsed() < Duration::from_secs(5) {
					match reader.read(&mut buf) {
						Ok(0) => break,
						Ok(n) => got.extend_from_slice(&buf[..n]),
						Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
							std::thread::sleep(Duration::from_micros(500));
						},
						Err(e) => panic!("reading the FIFO: {e}"),
					}
				}
				got
			});
			let after = tokio::time::timeout(
				STUCK,
				session.run_with(
					RunOptions::new("printf %s AFTER >&3"),
					stdio(),
					CancellationToken::new(),
				),
			)
			.await;
			assert_eq!(after.expect("the last run ended").unwrap().status, 0);
			// Lost, `AFTER` never comes: the reader stops after 5 s.
			(draining.join().unwrap(), cancelled.status)
		})
	}

	/// The bytes a FIFO's buffer holds: 64 KiB, but on Linux 8 KiB once its
	/// user's pipes pass `fs.pipe-user-pages-soft` (a whole-library run as
	/// root in a pod, where root lacks `CAP_SYS_RESOURCE`).
	fn fifo_room(reader: &std::fs::File) -> usize {
		#[cfg(target_os = "linux")]
		{
			use std::os::fd::AsRawFd;
			// SAFETY: fcntl on a descriptor the caller owns.
			let room = unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_GETPIPE_SZ) };
			usize::try_from(room).expect("F_GETPIPE_SZ")
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = reader;
			65_536
		}
	}

	/// The bytes that fill a tee on a FIFO of `room` bytes but for 4: the
	/// writes the FIFO takes whole, and one hold more. The tee's queue keeps
	/// a write (of [`TEE_HOLD`](crate::bash::TEE_HOLD) bytes, the room of
	/// an empty queue) until every target has all of it, so the part a
	/// smaller FIFO took still counts in the hold: on an 8 KiB FIFO the tee
	/// takes 65,536 bytes, not 8,192 more. Measured with a trace of the
	/// tee: the 73,724 '0's of `fifo_room + TEE_HOLD - 4` waited after
	/// 65,536, the cancel ended them there, and both targets got those
	/// 65,536 and `AFTER`, each byte the tee took once.
	const fn tee_fill(room: usize) -> usize {
		let hold = crate::bash::TEE_HOLD;
		room / hold * hold + hold - 4
	}

	/// Shrink a FIFO's buffer to `bytes` (Linux), as the kernel makes one
	/// when its user's pipes pass `fs.pipe-user-pages-soft`.
	#[cfg(target_os = "linux")]
	fn shrink_fifo(reader: &std::fs::File, bytes: usize) {
		use std::os::fd::AsRawFd;
		let size = libc::c_int::try_from(bytes).expect("a pipe size");
		// SAFETY: fcntl on a descriptor the caller owns.
		let got = unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_SETPIPE_SZ, size) };
		assert_eq!(usize::try_from(got).ok(), Some(bytes), "F_SETPIPE_SZ");
	}

	#[cfg(not(target_os = "linux"))]
	fn shrink_fifo(_reader: &std::fs::File, _bytes: usize) {}

	// Failure mode (review of #111 at 5773e4ed): a run cancelled while its
	// write through a tee waited dropped the write, but the session's vproc
	// kept its write key and the tee kept the write's progress under it, so
	// the next run's first write through the tee started at those offsets
	// and was lost. The dropped command takes the key with it.
	#[test]
	fn a_run_cancelled_during_a_write_through_a_tee_leaves_the_next_run_whole() {
		let (got, _) = drop_a_write_through_a_fifo_tee(
			|_| format!("printf %0{TEE_WAITS}d 0 >&3"),
			std::path::Path::new("/dev/null"),
			true,
		);
		some_zeros_then(&got, TEE_WAITS, b"AFTER");
	}

	/// What `command` writes to stderr in a session of its own, run whole.
	fn stderr_of(command: &str) -> Vec<u8> {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("stderr");
		let null = |write: bool| {
			std::fs::OpenOptions::new()
				.read(!write)
				.write(write)
				.open("/dev/null")
				.unwrap()
		};
		let stdio = RunStdio {
			stdin:  Some(null(false)),
			stdout: Some(null(true)),
			stderr: Some(std::fs::File::create(&path).unwrap()),
		};
		own_runtime().block_on(async {
			let mut session = session();
			tokio::time::timeout(
				STUCK,
				session.run_with(RunOptions::new(command), stdio, CancellationToken::new()),
			)
			.await
			.expect("the run ended")
			.unwrap();
		});
		std::fs::read(&path).unwrap()
	}

	// Failure mode (found in round 8): a diagnostic the shell queues
	// (`Vproc::out`: a command not found, a bad indirection) went on under
	// the vproc's key of the moment while it waited for room in a tee. After
	// a key change (a cancel's TERM trap's, a dropped command's) it started
	// again from its first byte, and the tee's file got it twice. And when
	// the kill that ends a cancel dropped the queue, the vproc could keep the
	// key, and the next run's write was lost. Each case: the FIFO and the
	// file both hold one part of the diagnostic, the same, each byte once,
	// then `AFTER`: the release's tee passes on only what it took, to every
	// target alike (#111's tee gave the file the whole diagnostic).
	#[test]
	fn a_queued_diagnostic_cancelled_during_its_write_through_a_tee_is_written_once() {
		let cases = [
			("not found", "$(printf %0262144d 0)"),
			("indirection", "x=$(printf %0262144d 0)a; : ${!x}"),
		];
		let mut wrong = Vec::new();
		for (what, command) in cases {
			let whole = stderr_of(command);
			assert!(whole.len() > TEE_WAITS, "{what}: the diagnostic is {} bytes", whole.len());
			for trap in ["", "trap 'exit 5' TERM; "] {
				let dir = tempfile::tempdir().unwrap();
				let file = dir.path().join("tee-file");
				let second = format!("{trap}exec 2>&3; {command}");
				let (got, status) = drop_a_write_through_a_fifo_tee(move |_| second, &file, true);
				let written = std::fs::read(&file).unwrap();
				let part = got
					.strip_suffix(b"AFTER")
					.is_some_and(|p| !p.is_empty() && p.len() < whole.len() && whole.starts_with(p));
				if written != got || !part {
					wrong.push(format!(
						"{what}{} (status {status}): the file {} bytes of a {}-byte diagnostic ({}), \
						 the FIFO {} bytes ({})",
						if trap.is_empty() { "" } else { ", TERM trap" },
						written.len(),
						whole.len(),
						if written.ends_with(b"AFTER") {
							"AFTER last"
						} else {
							"no AFTER"
						},
						got.len(),
						if part {
							"a part, then AFTER"
						} else {
							"not a part, then AFTER"
						},
					));
				}
			}
		}
		assert!(wrong.is_empty(), "{}", wrong.join("; "));
	}

	// Failure mode (review of #132 at 4b045c4d, item 1; here through a tee,
	// without #132): a host tool's write (`nohup --version`,
	// `timeout --version`) waited for room in a tee when the run was
	// cancelled, or when `kill -TERM $$` ended the shell. A tool wrote through
	// `ShellApi::write` under the vproc's key while its frame waited on the
	// call, so nothing marked the write part way, and the vproc kept the key
	// with the tee's progress under it: the next run's `printf %s AFTER`
	// counted as written where the tool's had got, the file never got
	// `AFTER`, and the run exited 0. A call writes with a key of its own,
	// which goes with it. Each case: the FIFO and the file both hold the
	// '0's, the same part of the tool's message (none: a short write goes
	// into a tee whole or not at all, `TEE_WHOLE`), then `AFTER`; the part
	// is a prefix of what the tool writes in a run of its own, so a message
	// written twice fails. The '0's fill the tee but for 4 bytes
	// ([`tee_fill`]), so `printf` has ended and the tool's message waits when
	// the run ends. (#111's tee gave the file the whole message.)
	#[test]
	fn a_tools_write_dropped_part_way_through_a_tee_leaves_the_next_run_whole() {
		let mut wrong = Vec::new();
		// Each case twice: with the FIFO as it is, and shrunk to 8 KiB, as a
		// FIFO is made when its user's pipes pass the soft limit.
		let rooms: &[Option<usize>] = if cfg!(target_os = "linux") {
			&[None, Some(8192)]
		} else {
			&[None]
		};
		let messages =
			["nohup", "timeout"].map(|tool| (tool, stderr_of(&format!("{tool} --version >&2"))));
		for (tool, whole) in &messages {
			assert!(
				whole.starts_with(format!("{tool} (pi) ").as_bytes()),
				"`{tool} --version` in a run of its own: {:?}",
				String::from_utf8_lossy(whole)
			);
		}
		for (how, ends, cancel) in
			[("cancelled", "", true), ("killed", "{ sleep 0.3; kill -TERM $$; } & ", false)]
		{
			for (tool, shrunk) in ["nohup", "timeout"]
				.into_iter()
				.flat_map(|t| rooms.iter().map(move |r| (t, *r)))
			{
				let dir = tempfile::tempdir().unwrap();
				let file = dir.path().join("tee-file");
				let counted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
				let (got, status) = drop_a_write_through_a_fifo_tee(
					{
						let counted = Arc::clone(&counted);
						move |reader| {
							if let Some(bytes) = shrunk {
								shrink_fifo(reader, bytes);
							}
							let zeros = tee_fill(fifo_room(reader));
							counted.store(zeros, Ordering::SeqCst);
							format!("{ends}printf %0{zeros}d 0 >&3; {tool} --version >&3")
						}
					},
					&file,
					cancel,
				);
				let zeros = counted.load(Ordering::SeqCst);
				let written = std::fs::read(&file).unwrap();
				let whole = &messages
					.iter()
					.find(|(t, _)| *t == tool)
					.expect("the tool's message")
					.1;
				let same = written == got
					&& got.len() >= zeros + 5
					&& got[..zeros].iter().all(|&b| b == b'0')
					&& got[zeros..]
						.strip_suffix(b"AFTER")
						.is_some_and(|p| whole.starts_with(p));
				if !same {
					wrong.push(format!(
						"{tool} {how} (status {status}): the file {} bytes ending {:?}, the FIFO {} \
						 bytes ending {:?}, after {} '0's written",
						written.len(),
						String::from_utf8_lossy(&written[written.len().saturating_sub(24)..]),
						got.len(),
						String::from_utf8_lossy(&got[got.len().saturating_sub(24)..]),
						zeros,
					));
				}
			}
		}
		assert!(wrong.is_empty(), "{}", wrong.join("; "));
	}

	/// A background extra still waiting for room on a run's stdout when the
	/// run ends is woken when the session drops that stdout, and ends: the
	/// next run's `wait` returns.
	#[test]
	fn an_extra_left_waiting_on_a_finished_runs_stdout_ends() {
		use std::{io::Write, os::fd::AsRawFd};
		const EXTRA: usize = 1 << 20;
		let command = format!("head -c {EXTRA} /dev/zero & read -r go");
		// Nobody reads: the extra fills the pipe and waits for room.
		let (out_r, out_w) = io::pipe().unwrap();
		let (in_r, mut in_w) = io::pipe().unwrap();
		let out_w = std::fs::File::from(std::os::fd::OwnedFd::from(out_w));
		let fd = out_w.as_raw_fd();
		let waited = crate::sys::pending_polls(fd);
		let given_up = Arc::new(AtomicBool::new(false));
		let go = {
			let given_up = Arc::clone(&given_up);
			std::thread::spawn(move || {
				if until(|| crate::sys::pending_polls(fd) > waited, &given_up) {
					in_w.write_all(b"go\n").unwrap();
				}
			})
		};
		let runtime = own_runtime();
		let ended = runtime.block_on(async {
			let mut session = session();
			let trace = Arc::new(crate::bash::trace::RunTrace::new(command.as_str()));
			let stdio = RunStdio {
				stdin:  Some(std::fs::File::from(std::os::fd::OwnedFd::from(in_r))),
				stdout: Some(out_w),
				stderr: Some(std::fs::File::open("/dev/null").unwrap()),
			};
			let options = RunOptions { events: Some(trace), ..RunOptions::new(command.as_str()) };
			let first =
				tokio::time::timeout(STUCK, session.run_with(options, stdio, CancellationToken::new()))
					.await;
			let Ok(first) = first else {
				return Err("the first run never ended: the extra never waited for room on stdout");
			};
			assert_eq!(first.unwrap().status, 0);
			// The first run ended, and the session dropped its stdout while
			// the extra still waited on it.
			match tokio::time::timeout(STUCK, sh(&mut session, "wait; echo \"waited $?\"")).await {
				Ok(waited) => Ok(waited.stdout),
				Err(_) => Err("the second run's `wait` never returned"),
			}
		});
		given_up.store(true, Ordering::SeqCst);
		drop(out_r);
		match ended {
			Ok(stdout) => {
				go.join().unwrap();
				assert_eq!(stdout, "waited 0\n");
			},
			Err(why) => {
				// The stuck extra's thread waits forever: leave it.
				runtime.shutdown_background();
				panic!(
					"{why}: the native extra `head -c {EXTRA} /dev/zero` waiting for room on the first \
					 run's stdout was never woken when the session dropped that stdout"
				);
			},
		}
	}

	/// Runs `script` with stdout a pipe the test filled with 'P's before the
	/// run, so a write through a zsh multios tee on stdout stays in the tee's
	/// queue; a reader starts 300 ms after the run did and reads to the end.
	/// Returns what stdout got after the 'P's.
	#[cfg(target_os = "linux")]
	fn stdout_after_a_full_pipe(script: &str) -> Vec<u8> {
		use std::{
			io::Write,
			os::fd::{AsRawFd, OwnedFd},
		};

		let runtime = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(1)
			.enable_all()
			.build()
			.unwrap();
		runtime.block_on(async {
			let mut s = session();
			let (mut out_r, out_w) = io::pipe().unwrap();
			let mut out_w = std::fs::File::from(OwnedFd::from(out_w));
			let fd = out_w.as_raw_fd();
			// SAFETY: fcntl on a descriptor this test owns.
			let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
			// SAFETY: as above.
			unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
			let mut filled = 0;
			loop {
				match out_w.write(&[b'P'; 4096]) {
					Ok(n) => filled += n,
					Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
					Err(e) => panic!("filling stdout: {e}"),
				}
			}
			// SAFETY: as above.
			unsafe { libc::fcntl(fd, libc::F_SETFL, flags) };
			let reader = std::thread::spawn(move || {
				std::thread::sleep(std::time::Duration::from_millis(300));
				let mut got = Vec::new();
				out_r.read_to_end(&mut got).unwrap();
				got
			});
			let stdio = RunStdio {
				stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
				stdout: Some(out_w),
				stderr: Some(
					std::fs::OpenOptions::new()
						.write(true)
						.open("/dev/null")
						.unwrap(),
				),
			};
			tokio::time::timeout(
				std::time::Duration::from_secs(60),
				s.run(script, stdio, CancellationToken::new()),
			)
			.await
			.unwrap_or_else(|_| panic!("the run did not return within 60 s"))
			.unwrap();
			drop(s);
			let got = reader.join().unwrap();
			assert!(
				got.len() >= filled && got[..filled].iter().all(|&b| b == b'P'),
				"stdout lost the {filled} 'P's the test wrote first"
			);
			got[filled..].to_vec()
		})
	}

	// Failure mode: `syswrite` through a zsh multios tee counted what the
	// tee had only queued as written and ended; the group's redirections
	// closed the tee, and what its queue held was lost (with 1 MiB, 983,040
	// of 1,048,576 bytes came out). A write through `FdRef::poll_write_out`
	// now ends once every target of the tee has its bytes.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_syswrite_through_a_multios_tee_is_out_before_the_tee_closes() {
		let got = stdout_after_a_full_pipe(
			"emulate zsh -c 'zmodload zsh/system; { syswrite -o 1 END; } >&1 >/dev/null'",
		);
		assert_eq!(String::from_utf8_lossy(&got), "END");
	}

	// Failure mode: as above for `sysread -o`, which writes what it read
	// through the same `FdRef::poll_write_out`.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_sysread_writing_through_a_multios_tee_is_out_before_the_tee_closes() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("in");
		std::fs::write(&path, "END").unwrap();
		let got = stdout_after_a_full_pipe(&format!(
			"emulate zsh -c 'zmodload zsh/system; {{ sysread -i 3 -o 1; }} 3<{} >&1 >/dev/null'",
			path.display()
		));
		assert_eq!(String::from_utf8_lossy(&got), "END");
	}

	// Failure mode: a builtin's output written at once (`write_now`, a
	// bash-mode `printf` with nothing queued before it) counted what a zsh
	// multios tee had only queued as written, so it was never settled; the
	// run ended, the shell's stdout (the tee `exec` made) closed, and the
	// bytes were lost. A tee's write now has a mark, which hands the output
	// to the staged writer that settles it.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_builtin_written_at_once_through_a_multios_tee_is_out_before_the_run_ends() {
		let got = stdout_after_a_full_pipe("emulate zsh -c 'exec >&1 >/dev/null'\nprintf %s END");
		assert_eq!(String::from_utf8_lossy(&got), "END");
	}
}
