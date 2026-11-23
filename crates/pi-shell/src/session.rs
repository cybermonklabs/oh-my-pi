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
//! has not ended after [`TERM_GRACE`], `KILL` (no traps, status 137).
//! Unwinding drops the externals the run waits for; the spawner sends their
//! process groups `TERM` and `KILL` after [`TERM_GRACE`] in the background.
//! The cancel request reaches the engine only from the driver, while the run
//! it targets is still in flight, so a late cancel never leaks into the next
//! command. What `nohup` started ([`crate::tools`]) is detached: neither a
//! cancel nor closing the session ends it.
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
		Budget, CallId, Cx, Engine, EngineConfig, EventMask, Fs, MemStore, PipeTap, RunId, Script,
		Shell, ShellError, ShellInit, Signal, Step, ToolCall, VprocSel,
		store::{Key, MiscKey, Record},
	},
	host::{PiHost, SpawnObserver, TERM_GRACE},
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
}

/// Failure of a [`Session`] call.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
	/// The engine refused the initial state.
	#[error("could not create the shell")]
	Create(#[source] ShellError),
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
	jobs:     Option<flume::Sender<Request>>,
	/// Rings the driver's bell.
	waker:    Waker,
	children: Children,
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
		let SessionConfig { env, cwd, fs, vfs, runtime, output_decoding } = config;
		let (jobs, rx) = flume::unbounded();
		let children = Children::default();
		let bell = Arc::new(Bell::default());
		let waker = Waker::from(Arc::clone(&bell));
		let tools = ToolConfig::from_env(&env, vfs.clone(), runtime.clone());
		let mut host = PiHost::new(fs, runtime.clone());
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
		let mut store = MemStore::new();
		let init = ShellInit { env, cwd, ..ShellInit::default() };
		let mut shell = Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, init)
			.map_err(SessionError::Create)?;
		// Nothing observes events: skip building them.
		shell.set_event_mask(EventMask::NONE);
		let driver = Driver { shell, store, host, bell, jobs: rx, children: children.clone(), tools };
		runtime.spawn(driver.serve());
		Ok(Self { jobs: Some(jobs), waker, children })
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
	/// [`TERM_GRACE`]) and the outcome says `cancelled`. Dropping the future
	/// stops the run with `KILL`. A non-zero status (`exit 3`, `set -e`,
	/// `nosuchcmd`) is an outcome, not an error: the session stays usable.
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
			if let Ok(r) = tokio::time::timeout(TERM_GRACE, &mut reply).await {
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
		match self.step(Budget::default()) {
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
		let RunOptions { command, env, cwd, pipe_tap, reported_error, text_capture } = options;
		self.host.set_pipe_tap(pipe_tap);
		self.host.set_reported_error(reported_error);
		// The values the overlay hides, restored after the run.
		let saved: Vec<(BString, Option<Record>)> = env
			.iter()
			.map(|(name, _)| (name.clone(), self.store.record(Key::Var(name.as_bstr())).cloned()))
			.collect();
		self
			.host
			.streams()
			.install([stdio.stdin, stdio.stdout, stdio.stderr], text_capture);
		self.shell.reset_root_stdio(&mut self.host);
		self.children.set_active(true);
		let run = self.shell.submit(Script {
			cwd,
			env,
			vproc: VprocSel::Root,
			..Script::command(command.as_bytes())
		});
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
			match self.step(Budget::default()) {
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
			// apply it now (it ends background work too, as pi's cancel
			// does), not at the start of the next command.
			match self.step(Budget { max_ops: 1, max_ns: u64::MAX }) {
				Step::Done { run, status } => self.on_done(run, status),
				Step::Call { id, call } => self.on_call(id, call),
				_ => {},
			}
		}
		let exited = self.shell.ended_by_exit(run);
		self.settle().await;
		self.children.set_active(false);
		self.host.streams().clear();
		self.host.set_pipe_tap(None);
		self.host.set_reported_error(None);
		self.restore_overlay(saved);
		let cwd = match self.store.record(Key::Misc(MiscKey::Cwd)) {
			Some(Record::Misc(cwd)) => cwd.clone(),
			_ => BString::default(),
		};
		// The caller may have stopped waiting (dropped future).
		let _ = reply.send(RunOutcome { status, cancelled: applied > 0, exited, cwd });
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
		self.tools.on_done(run, status, signal);
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
		let stdio = RunStdio {
			stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
			stdout: Some(std::fs::File::from(std::os::fd::OwnedFd::from(out_w))),
			stderr: Some(std::fs::File::from(std::os::fd::OwnedFd::from(err_w))),
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

	fn alive(pid: i32) -> bool {
		// SAFETY: signal 0 only probes existence.
		unsafe { libc::kill(pid, 0) == 0 }
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
		let outcome = tokio::time::timeout(
			Duration::from_secs(1),
			s.run("/bin/sleep 2 &", stdio, CancellationToken::new()),
		)
		.await
		.expect("a background external holding stdout must not delay the run")
		.unwrap();
		assert_eq!(outcome.status, 0);
		assert_eq!(sh(&mut s, "wait %1").await.outcome.status, 0);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn background_job_remains_waitable_in_later_run() {
		let mut s = session();
		s.run("(sleep 0.1; exit 7) &", RunStdio::default(), CancellationToken::new())
			.await
			.unwrap();
		assert_eq!(sh(&mut s, "sleep 0.3; wait %1").await.outcome.status, 7);
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
		let started = Instant::now();
		let (outcome, (pid, (pgid, sid, own_group))) =
			tokio::join!(s.run("/bin/sleep 30", RunStdio::default(), cancel.clone()), probe);
		let outcome = outcome.unwrap();
		assert!(outcome.cancelled);
		assert_eq!(outcome.status, 143);
		assert!(started.elapsed() < Duration::from_secs(5), "cancel took {:?}", started.elapsed());
		assert_eq!((pgid, sid), (pid, pid), "the external leads its own session");
		assert_ne!(pgid, own_group);
		assert!(children.pids().is_empty(), "no run in flight");
		let gone = Instant::now();
		while alive(pid) && gone.elapsed() < Duration::from_secs(3) {
			tokio::time::sleep(Duration::from_millis(20)).await;
		}
		assert!(!alive(pid), "sleep {pid} survived the cancel");
		// The session is still usable.
		assert_eq!(sh(&mut s, "echo ok").await.stdout, "ok\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn trapped_term_escalates_to_kill() {
		let mut s = session();
		let cancel = CancellationToken::new();
		let trigger = cancel.clone();
		tokio::spawn(async move {
			tokio::time::sleep(Duration::from_millis(200)).await;
			trigger.cancel();
		});
		let started = Instant::now();
		let outcome = s
			.run("trap 'while :; do :; done' TERM; while :; do :; done", RunStdio::default(), cancel)
			.await
			.unwrap();
		assert!(outcome.cancelled);
		assert_eq!(outcome.status, 137);
		assert!(started.elapsed() < Duration::from_secs(4), "took {:?}", started.elapsed());
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
				let runtime = tokio::runtime::Builder::new_multi_thread()
					.worker_threads(1)
					.enable_all()
					.build()
					.unwrap();
				let errors = runtime.block_on(async {
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
					tokio::time::timeout(
						std::time::Duration::from_secs(10),
						s.run(
							"trap '' PIPE; echo y; echo \"status=$?\" >&2",
							stdio,
							CancellationToken::new(),
						),
					)
					.await
					.unwrap_or_else(|_| panic!("DEADLINE fired: the run did not return within 10 s"))
					.unwrap();
					errors.join().unwrap()
				});
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
	/// later command must run. Returns fd 1 while the pipe was held, fd 1 at
	/// the end, and what the drained pipe held after its fill.
	#[cfg(target_os = "linux")]
	fn run_with_held_stderr(script: &str) -> (String, String, String) {
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
			let run = s.run(script, stdio, CancellationToken::new());
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
		crate::sys::in_blocking_writer_process(test, || {
			let (while_held, end, drained) = run_with_held_stderr(script);
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
}
