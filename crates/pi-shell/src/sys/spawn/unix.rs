//! Unix spawning.
//!
//! **Paths.** On Linux an external starts in a vfork child (`vfork`): a
//! `clone(CLONE_VM | CLONE_VFORK)` child, cloned by a launcher thread of the
//! spawning thread (whose own signal mask never changes), that, on data
//! prepared before the clone, places itself, takes a foreground job's
//! terminal, sets the umask and cwd, installs the fds, sets every signal's
//! disposition, empties its signal mask, sets its OOM adjustment and the
//! resource limits, and execs the program. The clone copies none of the
//! host's memory, and the kernel lets a vfork child set its own OOM
//! adjustment without changing the host's. The adjustment, 1000, has the
//! kernel kill the external and what it starts before the host when it
//! picks one process to kill for lack of memory; it does not spare the host
//! when a cgroup is killed as a whole (`memory.oom.group=1`).
//!
//! On macOS, `posix_spawn` whenever it can express the spec: placement via
//! `POSIX_SPAWN_SETSID`/`SETPGROUP`, stdio and extra fds via `adddup2`, cwd
//! via `addchdir_np`, every signal not to be ignored reset to its default
//! (`SETSIGDEF`, which restores `SIGPIPE` that Rust hosts ignore), an empty
//! signal mask, and `POSIX_SPAWN_CLOEXEC_DEFAULT` so no stray host fd leaks
//! into the child. It cannot set a umask or *ignore* a signal, so a spec
//! whose umask differs from the process's, or that ignores a signal the host
//! does not ignore, takes the fork path: std's `Command` with an
//! async-signal-safe `pre_exec` hook (umask, extra fds, dispositions,
//! `setsid`), the only path on other Unix systems.
//!
//! A spec with redirections for the process to apply
//! ([`SpawnSpec::redirs`]) takes a bare `fork`: the other paths wait for the
//! exec, and an open in the child may wait for a FIFO's other end, which
//! only the child may do (`fork_redirs`). On Linux that child sets its OOM
//! adjustment too.
//!
//! **glibc's own signals**, 32 and 33, reach every external as bash's fork
//! and exec leaves them: ignored when the process ignores them, else at
//! their default (`internal`). An ignore the process inherited is passed
//! on only on glibc 2.34 or later (see `internal`).
//!
//! **Placement** follows [`Sessions`]: `Detach` makes every external a
//! session leader; `Share` uses the `setpgid` leader idiom (`New` leads a
//! group, `Join` joins one) but never joins a group whose leader is in
//! another session, and falls back to leading its own group when the join
//! fails with `EPERM` (the group emptied in between); `Inherit` leaves the
//! child in the host's group and session, and every group-wide operation
//! then targets the child's pid alone (a [`Scope`]). A job-controlled spawn
//! (`PgroupSpec::Job`, under `Share` or `Inherit`) is placed like a `Share`
//! one; a foreground job's child also takes the shell's terminal before it
//! execs (the vfork child on Linux, the fork path elsewhere: `posix_spawn`
//! cannot), and the parent places it and hands over the terminal again
//! after the spawn, so neither side races the other.
//!
//! **Busy programs.** On the vfork, `posix_spawn` and fork paths an exec
//! that fails with `ETXTBSY` comes back at once as [`super::Started::Busy`],
//! no process left of it, with the spawn kept for another try after a wait
//! on the caller's timer ([`super::Started::settle`]); or, as the spec asks
//! ([`OnBusy`]), as `ETXTBSY` at once, or through `fork_redirs` with no
//! redirections. The child of `fork_redirs`, whose exec the parent does not
//! wait for, tries again itself after the same waits, once it closed every
//! close-on-exec descriptor.
//!
//! **Waiting** reports stops and continues besides the exit
//! ([`ExtProc::poll_event`]).

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
	cell::RefCell,
	ffi::{CString, OsStr, c_char},
	fs, io,
	io::Read as _,
	os::{
		fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd},
		unix::{ffi::OsStrExt, fs::OpenOptionsExt as _},
	},
	path::Path,
	sync::{Arc, LazyLock},
	task::{Context, Poll},
	thread,
	time::{Duration, Instant},
};
#[cfg(not(target_os = "linux"))]
use std::{
	os::unix::process::CommandExt,
	process::{Command, Stdio},
};

use bstr::BString;
use parking_lot::{Condvar, Mutex, MutexGuard};
use pi_builtins::read_process_umask as process_umask;

use super::{Dir, Leftover, Sessions, Shared, Started, child_end};
use crate::{
	bash::{
		ChildRedir, ChildRedirs, EnvView, ExitStatus, ExtProc, OnBusy, OpenFlags, OsHandle,
		PgroupSpec, Platform, ProcEvent, Rlimit, SigSet, Signal, SpawnSpec, StdioSpec,
	},
	sys::{
		lifecycle::{Abandon, Tracker},
		proc::{self, ProcInfo, ProcState},
		pump::{Feed, Pump, Pumps},
		rlimit,
	},
};

/// Include Linux realtime signal 64; macOS has only signals 1 through 31.
#[cfg(target_os = "linux")]
const NSIG: usize = 65;
#[cfg(not(target_os = "linux"))]
const NSIG: usize = 32;

/// Waiter and escalation threads only wait and signal.
const SMALL_STACK: usize = 64 << 10;

/// Registry sweep interval (amortized O(1) per spawn).
const SWEEP: usize = 64;

/// Waiter threads kept parked between externals (process-wide).
const IDLE_MAX: usize = 8;

/// How long a parked waiter waits for its next external before it exits.
const IDLE_FOR: Duration = Duration::from_secs(10);

/// One external to wait for: its pid and its lifecycle.
type Wait = (i32, Arc<Tracker>, Arc<Shared>);

/// A parked waiter thread's slot for its next external.
struct Mailbox {
	job:   Mutex<Option<Wait>>,
	ready: Condvar,
}

/// Parked waiter threads, shared by every spawner of the process: reusing
/// one saves a thread creation and teardown (stack, guard page, signal
/// stack) per external, about a tenth of a spawn's cost on Linux.
static IDLE: Mutex<Vec<Arc<Mailbox>>> = Mutex::new(Vec::new());

/// Wait for the exit of `pid` on a parked waiter, or a new one: it records
/// the status in `tracker` and reaps the process when nobody holds its
/// `ExtProc` any more.
fn watch(pid: i32, tracker: Arc<Tracker>, shared: Arc<Shared>) -> io::Result<()> {
	let parked = IDLE.lock().pop();
	if let Some(mb) = parked {
		*mb.job.lock() = Some((pid, tracker, shared));
		mb.ready.notify_one();
		return Ok(());
	}
	let mb =
		Arc::new(Mailbox { job: Mutex::new(Some((pid, tracker, shared))), ready: Condvar::new() });
	crate::sys::thread::spawn_helper(
		thread::Builder::new()
			.name("obash-wait".into())
			.stack_size(SMALL_STACK),
		move || waiter(&mb),
	)
	.map(drop)
}

/// A waiter thread: wait for each external handed to `mb`, park in
/// [`IDLE`] in between; exit when the pool is full or after [`IDLE_FOR`]
/// without work.
fn waiter(mb: &Arc<Mailbox>) {
	while let Some((pid, tracker, shared)) = next_wait(mb) {
		let status = wait_exit(pid, &tracker);
		if tracker.exited(status) {
			shared.state.reap(pid);
		}
		drop(tracker);
		let mut idle = IDLE.lock();
		if idle.len() >= IDLE_MAX {
			return;
		}
		idle.push(Arc::clone(mb));
	}
}

/// The next external for the waiter of `mb`; `None` once it left the pool
/// after [`IDLE_FOR`] without one.
fn next_wait(mb: &Arc<Mailbox>) -> Option<Wait> {
	let mut job = mb.job.lock();
	loop {
		if let Some(next) = job.take() {
			return Some(next);
		}
		if !mb.ready.wait_for(&mut job, IDLE_FOR).timed_out() || job.is_some() {
			continue;
		}
		// Leave the pool, unless a spawner took this waiter from it already
		// (its external is on the way). `watch` locks the pool before a
		// mailbox, so the pool is not locked while holding `job`.
		let left = MutexGuard::unlocked(&mut job, || {
			let mut idle = IDLE.lock();
			let before = idle.len();
			idle.retain(|m| !Arc::ptr_eq(m, mb));
			idle.len() < before
		});
		if left && job.is_none() {
			return None;
		}
	}
}

/// Platform state of a spawner.
pub(super) struct State {
	/// The process umask when the spawner was created. On macOS
	/// `posix_spawn` cannot set another, so specs asking for one take the
	/// fork path there.
	umask:       Option<u32>,
	groups:      Mutex<Groups>,
	/// The libc extension that lets `posix_spawn` set the child's cwd.
	#[cfg(target_os = "macos")]
	add_chdir:   Option<posix::AddChdir>,
	/// The record of every abandon escalation, in the order the externals
	/// were dropped.
	#[cfg(test)]
	escalations: Mutex<Vec<Arc<Mutex<Escalation>>>>,
}

/// Scopes the spawner created, for leak checks.
struct Groups {
	list:       Vec<Scope>,
	next_sweep: usize,
}

/// What group-wide operations of one external reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
	/// The process group it leads or joined.
	Group(i32),
	/// The session it leads (and the group of the same id).
	Session(i32),
	/// Only the unreaped process itself (`Sessions::Inherit`: the group
	/// is the host's). Retired under the registry lock before reaping.
	Process { pid: i32 },
}

impl Scope {
	/// The scope of an external `pid` spawned at `place`.
	const fn of(place: Place, pid: i32) -> Self {
		match place {
			Place::Session => Self::Session(pid),
			Place::Group(0) => Self::Group(pid),
			Place::Group(pgid) => Self::Group(pgid),
			Place::Inherit => Self::Process { pid },
		}
	}

	/// The id reported in a [`Leftover`].
	const fn id(self) -> i32 {
		match self {
			Self::Group(id) | Self::Session(id) | Self::Process { pid: id, .. } => id,
		}
	}

	const fn contains(self, p: &ProcInfo) -> bool {
		match self {
			Self::Group(pgid) => p.pgid == pgid,
			Self::Session(sid) => p.sid == sid,
			Self::Process { pid } => p.pid == pid,
		}
	}

	/// Whether anything is left in the scope.
	fn alive(self) -> bool {
		match self {
			Self::Group(id) | Self::Session(id) => group_alive(id),
			// Registered only while unreaped; zombies are filtered by the
			// caller, and reaping retires the entry under this same lock.
			Self::Process { .. } => true,
		}
	}

	/// Send `sig` to the scope. Only valid while the external is unreaped
	/// (its pid and group cannot be recycled then).
	///
	/// A session's group exists only once its leader ran `setsid`, which
	/// the child does itself after the fork; until then the leader is the
	/// only member, so the signal goes to its pid (else it is lost: a
	/// `kill $!` right after the spawn left the program running).
	fn signal(self, sig: Signal) -> io::Result<()> {
		let n = i32::from(sig.number(Platform::current()));
		let rc = match self {
			// SAFETY: plain syscall without pointer arguments.
			Self::Group(id) => unsafe { libc::killpg(id, n) },
			// SAFETY: as above.
			Self::Session(id) => match unsafe { libc::killpg(id, n) } {
				// SAFETY: as above.
				-1 if errno() == libc::ESRCH => unsafe { libc::kill(id, n) },
				rc => rc,
			},
			// SAFETY: as above.
			Self::Process { pid, .. } => unsafe { libc::kill(pid, n) },
		};
		if rc == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}

	/// KILL whatever is left in the scope after the external exited
	/// (identity-pinned; a `Process` scope has nothing beyond the pid): the
	/// processes signalled, or the error of a scan that read only some.
	fn sweep(self) -> io::Result<Vec<ProcInfo>> {
		match self {
			Self::Group(id) => proc::kill_group(id, Signal::Kill),
			Self::Session(id) => proc::kill_session(id, Signal::Kill),
			Self::Process { .. } => Ok(Vec::new()),
		}
	}

	/// The live (not zombie) processes of the scope.
	#[cfg(test)]
	fn members(self) -> io::Result<Vec<ProcInfo>> {
		let mut all = match self {
			Self::Group(id) => proc::group_members(id)?,
			Self::Session(id) => proc::session_members(id)?,
			Self::Process { pid } => proc::read(pid)?.into_iter().collect(),
		};
		all.retain(|p| p.state != ProcState::Zombie);
		Ok(all)
	}
}

/// What the abandon escalation of one external did, as it recorded it
/// ([`NativeSpawner::escalations`](super::NativeSpawner::escalations)): what
/// tests assert on, rather than on how long a process took to go on a busy
/// host.
#[cfg(test)]
#[derive(Clone, Debug)]
pub struct Escalation {
	/// The scope's id: session, group, or the external's own pid.
	pub scope:     i32,
	/// The external still ran when its `ExtProc` was dropped (rather than
	/// having exited without the engine collecting it).
	pub running:   bool,
	/// When the `ExtProc` was dropped.
	pub abandoned: Instant,
	/// The KILL step, once it ran.
	pub fired:     Option<Fired>,
}

/// The KILL step of an [`Escalation`].
#[cfg(test)]
#[derive(Clone, Debug)]
pub struct Fired {
	/// The deadline it waited for: when the escalation scheduled KILL.
	pub due:    Instant,
	/// When it ran.
	pub at:     Instant,
	/// The scope's live processes just before it: what TERM and the grace
	/// left.
	pub alive:  Result<Vec<ProcInfo>, String>,
	/// KILL went to the scope: its leader still ran.
	pub killed: bool,
	/// The processes the sweep then sent KILL, once it ran (identity-pinned).
	pub swept:  Option<Result<Vec<ProcInfo>, String>>,
}

/// Where an abandon escalation records what it does (`Escalation`): in
/// test builds only, a no-op otherwise.
#[derive(Clone)]
struct Journal(#[cfg(test)] Arc<Mutex<Escalation>>);

impl Journal {
	/// The record of the escalation of `scope`, whose `ExtProc` was dropped
	/// at `abandoned` while it ran (`running`) or after it exited, opened in
	/// `state`.
	#[cfg_attr(not(test), expect(clippy::missing_const_for_fn, reason = "records in test builds"))]
	fn open(state: &State, scope: Scope, running: bool, abandoned: Instant) -> Self {
		#[cfg(test)]
		{
			let entry =
				Arc::new(Mutex::new(Escalation { scope: scope.id(), running, abandoned, fired: None }));
			state.escalations.lock().push(Arc::clone(&entry));
			Self(entry)
		}
		#[cfg(not(test))]
		{
			let _ = (state, scope, running, abandoned);
			Self()
		}
	}

	/// The KILL step, due at `due`, runs now on `scope`; `killed` when it
	/// sends KILL to it. Called before the signal goes out.
	#[cfg_attr(not(test), expect(clippy::missing_const_for_fn, reason = "records in test builds"))]
	fn fire(&self, scope: Scope, killed: bool, due: Instant) {
		#[cfg(test)]
		{
			let at = Instant::now();
			let alive = scope.members().map_err(|e| e.to_string());
			self.0.lock().fired = Some(Fired { due, at, alive, killed, swept: None });
		}
		#[cfg(not(test))]
		let _ = (self, scope, killed, due);
	}

	/// The sweep after the KILL step ran, with this outcome.
	#[cfg_attr(not(test), expect(clippy::missing_const_for_fn, reason = "records in test builds"))]
	fn swept(&self, outcome: &io::Result<Vec<ProcInfo>>) {
		#[cfg(test)]
		if let Some(fired) = &mut self.0.lock().fired {
			fired.swept = Some(match outcome {
				Ok(swept) => Ok(swept.clone()),
				Err(error) => Err(error.to_string()),
			});
		}
		#[cfg(not(test))]
		let _ = (self, outcome);
	}
}

impl State {
	/// State for a spawner; `umask` is the process umask when the host knows
	/// it (read here otherwise).
	pub(super) fn new(umask: Option<u32>) -> Self {
		Self {
			umask: umask.or_else(process_umask),
			groups: Mutex::new(Groups { list: Vec::new(), next_sweep: SWEEP }),
			#[cfg(target_os = "macos")]
			add_chdir: posix::add_chdir(),
			#[cfg(test)]
			escalations: Mutex::new(Vec::new()),
		}
	}

	/// The record of every abandon escalation so far.
	#[cfg(test)]
	pub(super) fn escalations(&self) -> Vec<Escalation> {
		self
			.escalations
			.lock()
			.iter()
			.map(|entry| entry.lock().clone())
			.collect()
	}

	/// The process umask when the spawner was created.
	pub(super) const fn umask(&self) -> Option<u32> {
		self.umask
	}

	fn record(&self, s: Scope) {
		let mut gs = self.groups.lock();
		if !gs.list.contains(&s) {
			gs.list.push(s);
		}
		if gs.list.len() >= gs.next_sweep {
			gs.list.retain(|s| s.alive());
			gs.next_sweep = gs.list.len() + SWEEP;
		}
	}

	/// Whether `posix_spawn` can express a spec with this umask and these
	/// ignored signals (it can neither set a umask nor ignore a signal; the
	/// child inherits both from the host).
	#[cfg(target_os = "macos")]
	fn posix_eligible(&self, umask: u32, ign: SigSet) -> bool {
		self.umask == Some(umask) && ign.iter().all(host_ignores)
	}

	/// Retire a process-only scope before its pid can be reused. Readers
	/// hold this lock while collecting the process table too.
	fn reap(&self, pid: i32) {
		let mut gs = self.groups.lock();
		gs.list.retain(|s| *s != Scope::Process { pid });
		reap(pid);
	}
}

/// Whether process group `pgid` has a member (`EPERM`: exists, not ours).
fn group_alive(pgid: i32) -> bool {
	// SAFETY: plain syscall; signal 0 only checks existence and permission.
	let alive = unsafe { libc::kill(-pgid, 0) } == 0;
	alive || io::Error::last_os_error().kind() == io::ErrorKind::PermissionDenied
}

pub(super) fn dup(h: OsHandle) -> io::Result<fs::File> {
	let fd = RawFd::try_from(h.0).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
	// SAFETY: the engine keeps the fd object that owns this descriptor alive
	// for the whole spawn call.
	let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
	Ok(fs::File::from(borrowed.try_clone_to_owned()?))
}

fn invalid(e: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, e)
}

/// One of the child's fds until the spawn: a descriptor the spawner owns
/// (closed after the spawn, so pumps see the child's end of file) or the
/// engine's own handle of an inherited stream, installed as it is (the
/// engine keeps it open for the spawn call; a copy cost a `dup` and a
/// `close` per stream and spawn).
enum Source {
	Owned(OwnedFd),
	Host(RawFd),
}

impl AsFd for Source {
	fn as_fd(&self) -> BorrowedFd<'_> {
		match self {
			Self::Owned(fd) => fd.as_fd(),
			// SAFETY: the engine keeps the fd object that owns this
			// descriptor alive for the whole spawn call.
			Self::Host(fd) => unsafe { BorrowedFd::borrow_raw(*fd) },
		}
	}
}

impl AsRawFd for Source {
	fn as_raw_fd(&self) -> RawFd {
		self.as_fd().as_raw_fd()
	}
}

/// The child's fd for one stream (`/dev/null` for `Null`).
fn child_fd(
	shared: &Shared,
	spec: crate::bash::StdioSpec,
	dir: Dir,
	pumps: &mut Vec<Pump>,
	held: &mut Vec<Arc<Feed>>,
) -> io::Result<Source> {
	if let crate::bash::StdioSpec::Inherit(h) = spec {
		return RawFd::try_from(h.0).map(Source::Host).map_err(invalid);
	}
	match child_end(shared, spec, dir, pumps, held)? {
		Some(f) => Ok(Source::Owned(f.into())),
		None => Ok(Source::Owned(
			fs::File::options()
				.read(true)
				.write(true)
				.open("/dev/null")?
				.into(),
		)),
	}
}

/// Move every source fd above every target fd, so installing one target
/// (`dup2`) can never clobber a source still to be installed.
fn lift(fds: &mut [(i32, Source)]) -> io::Result<()> {
	let floor = floor(fds);
	for (_, fd) in fds.iter_mut() {
		if fd.as_raw_fd() < floor {
			*fd = Source::Owned(dup_above(fd.as_raw_fd(), floor)?);
		}
	}
	Ok(())
}

/// Make every source the spawner's own, a copy above every target as
/// [`lift`] left them: the engine keeps its own handles open only for the
/// spawn call, and a busy spawn tries again after that ([`Busy`]).
fn own(fds: &mut [(i32, Source)]) -> io::Result<()> {
	let floor = floor(fds);
	for (_, fd) in fds.iter_mut() {
		if let Source::Host(handle) = *fd {
			*fd = Source::Owned(dup_above(handle, floor)?);
		}
	}
	Ok(())
}

/// The lowest number above every target of `fds`.
fn floor(fds: &[(i32, Source)]) -> RawFd {
	fds.iter().map(|(t, _)| *t).max().unwrap_or(2).max(2) + 1
}

/// A close-on-exec copy of `fd`, numbered `floor` or above.
fn dup_above(fd: RawFd, floor: RawFd) -> io::Result<OwnedFd> {
	// SAFETY: fcntl on an fd we hold; returns a new descriptor.
	let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, floor) };
	if copy < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: a successful F_DUPFD_CLOEXEC returned a descriptor we own.
	Ok(unsafe { OwnedFd::from_raw_fd(copy) })
}

/// Where the child goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
	/// Lead a new session (and group).
	Session,
	/// `setpgid(0, pgid)`: `0` leads a new group.
	Group(i32),
	/// Stay in the host's group and session.
	Inherit,
}

impl Place {
	const fn joins(self) -> bool {
		matches!(self, Self::Group(p) if p != 0)
	}
}

fn place(sessions: Sessions, pgroup: PgroupSpec) -> io::Result<Place> {
	let join = |pgid: u32| -> io::Result<Place> {
		let pgid = i32::try_from(pgid).map_err(invalid)?;
		Ok(if joinable(pgid) {
			Place::Group(pgid)
		} else {
			Place::Group(0)
		})
	};
	Ok(match (sessions, pgroup) {
		(Sessions::Detach, _) => Place::Session,
		(Sessions::Inherit, PgroupSpec::New(_) | PgroupSpec::Join(_)) => Place::Inherit,
		(Sessions::Share, PgroupSpec::New(_))
		| (Sessions::Share | Sessions::Inherit, PgroupSpec::Job { join: None, .. }) => Place::Group(0),
		(Sessions::Share, PgroupSpec::Join(pgid))
		| (Sessions::Share | Sessions::Inherit, PgroupSpec::Job { join: Some(pgid), .. }) => join(pgid)?,
	})
}

/// The terminal a job-controlled foreground spawn hands its group
/// ([`PgroupSpec::Job`]); `None` for every other spawn.
fn job_terminal(place: Place, pgroup: PgroupSpec) -> io::Result<Option<RawFd>> {
	match (place, pgroup) {
		(Place::Group(_), PgroupSpec::Job { terminal: Some(h), .. }) => {
			RawFd::try_from(h.0).map(Some).map_err(invalid)
		},
		_ => Ok(None),
	}
}

/// Make `pgid` the foreground group of terminal `tty` (zsh `attachtty`),
/// with `SIGTTOU` blocked: the caller may itself be in a background group
/// by now (the shell after its job took the terminal). Async-signal-safe:
/// the forked child calls it before it execs.
fn attach_tty(tty: RawFd, pgid: i32) {
	// SAFETY: sigset_t is plain data; the calls only read and write the sets
	// passed, and tcsetpgrp takes no pointers.
	unsafe {
		let mut ttou = std::mem::zeroed::<libc::sigset_t>();
		let mut old = std::mem::zeroed::<libc::sigset_t>();
		libc::sigemptyset(&raw mut ttou);
		libc::sigaddset(&raw mut ttou, libc::SIGTTOU);
		libc::pthread_sigmask(libc::SIG_BLOCK, &raw const ttou, &raw mut old);
		libc::tcsetpgrp(tty, pgid);
		libc::pthread_sigmask(libc::SIG_SETMASK, &raw const old, std::ptr::null_mut());
	}
}

/// Whether to try joining group `pgid`: never when its leader lives in
/// another session (a detached child: `setpgid` would fail with `EPERM`).
/// When the leader's session is unknown (macOS answers `ESRCH` for an
/// unreaped zombie leader, which still holds the group), the join is tried
/// and an `EPERM` falls back to leading a new group.
fn joinable(pgid: i32) -> bool {
	// SAFETY: plain syscalls without pointer arguments.
	let (theirs, ours) = unsafe { (libc::getsid(pgid), libc::getsid(0)) };
	pgid > 0 && (theirs < 0 || theirs == ours)
}

/// Signal dispositions for the child: `true` = ignored.
fn ignored(ign: SigSet) -> [bool; NSIG] {
	let mut out = [false; NSIG];
	for sig in ign.iter() {
		if let Some(slot) = out.get_mut(usize::from(sig.number(Platform::current()))) {
			*slot = true;
		}
	}
	out
}

/// Generation of the process's signal dispositions, bumped by
/// [`dispositions_changed`].
#[cfg(target_os = "macos")]
static DISPOSITIONS: AtomicU64 = AtomicU64::new(1);

/// The signals the process ignores, as [`host_ignored`] last read them, and
/// the [`DISPOSITIONS`] generation of that reading.
#[cfg(target_os = "macos")]
static HOST_IGNORED: Mutex<(u64, [bool; NSIG])> = Mutex::new((0, [false; NSIG]));

/// See [`crate::sys::dispositions_changed`].
#[cfg(target_os = "macos")]
pub(super) fn dispositions_changed() {
	DISPOSITIONS.fetch_add(1, Ordering::Release);
}

/// The signals the process ignores (`true` at their numbers): read once per
/// generation of the dispositions, not per spawn.
#[cfg(target_os = "macos")]
fn host_ignored() -> [bool; NSIG] {
	let generation = DISPOSITIONS.load(Ordering::Acquire);
	let mut cached = HOST_IGNORED.lock();
	if cached.0 != generation {
		let mut ignored = [false; NSIG];
		for (n, slot) in ignored.iter_mut().enumerate().skip(1) {
			// SAFETY: sigaction is plain data, valid zeroed.
			let mut old: libc::sigaction = unsafe { std::mem::zeroed() };
			// SAFETY: a null new action only queries; `old` is writable.
			let rc = unsafe { libc::sigaction(n as i32, std::ptr::null(), &raw mut old) };
			*slot = rc == 0 && old.sa_sigaction == libc::SIG_IGN;
		}
		*cached = (generation, ignored);
	}
	cached.1
}

/// Whether the host itself ignores `sig` (children inherit that through
/// `posix_spawn`).
#[cfg(target_os = "macos")]
fn host_ignores(sig: Signal) -> bool {
	let n = usize::from(sig.number(Platform::current()));
	host_ignored().get(n).copied().unwrap_or(false)
}

/// glibc's own signals, 32 (`SIGCANCEL`) and 33 (`SIGSETXID`), which its
/// `sigaction`, `signal` and `sigaddset` refuse: read and set with the
/// system call, and put in the vfork child's signal set by bit
/// ([`internal::ignored_bits`]). An external starts with each ignored when
/// the process ignores it ([`internal::ignored`]), else at its default, on
/// every path. An ignore the process inherited and glibc then replaced with
/// its own handler is passed on only on glibc 2.34 or later
/// ([`internal::IGNORED_AT_LOAD`]). Only on `x86_64` and aarch64, whose
/// layouts below are checked: elsewhere the vfork child gives both their
/// default.
#[cfg(all(
	target_os = "linux",
	target_env = "gnu",
	any(target_arch = "x86_64", target_arch = "aarch64")
))]
mod internal {
	use std::{
		io, ptr,
		sync::atomic::{AtomicU8, Ordering},
	};

	/// The signals, in the order of [`ignored`]'s answer.
	pub(super) const SIGNALS: [i32; 2] = [32, 33];

	/// The kernel's `struct sigaction` on `x86_64` and aarch64, as words:
	/// handler, flags, restorer, mask.
	pub(super) type Action = [usize; 4];

	/// The handler's word of an [`Action`].
	pub(super) const HANDLER: usize = 0;

	/// An action with `handler`, no flags and an empty mask.
	pub(super) const fn with_handler(handler: libc::sighandler_t) -> Action {
		[handler, 0, 0, 0]
	}

	/// `sig`'s action, replaced by `new` when given. Async-signal-safe.
	pub(super) fn action(sig: i32, new: Option<&Action>) -> io::Result<Action> {
		let mut old: Action = [0; 4];
		// SAFETY: `new` is null or a valid action, `old` is writable and as
		// large as the kernel's struct, and the kernel's sigset is 8 bytes.
		let rc = unsafe {
			libc::syscall(
				libc::SYS_rt_sigaction,
				sig,
				new.map_or(ptr::null(), ptr::from_ref),
				&raw mut old,
				size_of::<u64>(),
			)
		};
		if rc == 0 {
			Ok(old)
		} else {
			Err(io::Error::last_os_error())
		}
	}

	/// Set once read: [`IGNORED_AT_LOAD`] holds the reading at load.
	pub(super) const READ: u8 = 0x80;

	/// Bit `i` set: the process ignored `SIGNALS[i]` when it was loaded
	/// ([`READ`] marks the reading done).
	pub(super) static IGNORED_AT_LOAD: AtomicU8 = AtomicU8::new(0);

	/// Fills [`IGNORED_AT_LOAD`] when the program or library is loaded. On
	/// glibc 2.34 or later, glibc gives `SIGSETXID` a handler of its own at
	/// the process's first thread (and `SIGCANCEL` at its first
	/// `pthread_cancel`), so a later reading cannot see it was ignored; a
	/// program reads before any thread. A library loaded into a process
	/// that already runs threads reads that process's handler, and its
	/// children get the default. On glibc 2.33 and older, libpthread
	/// installs both handlers in its preinit function, which runs before
	/// every other initializer (`-z initfirst`), so this reading never sees
	/// an inherited ignore and children get both at the default. obash's
	/// `--fault-mode=exec` re-exec loses the reading too: the exec resets
	/// glibc's handlers to the default before the new image reads.
	#[used]
	#[unsafe(link_section = ".init_array")]
	static READ_AT_LOAD: extern "C" fn() = read_at_load;

	extern "C" fn read_at_load() {
		let mut bits = READ;
		for (i, sig) in SIGNALS.into_iter().enumerate() {
			if action(sig, None).is_ok_and(|a| a[HANDLER] == libc::SIG_IGN) {
				bits |= 1 << i;
			}
		}
		IGNORED_AT_LOAD.store(bits, Ordering::Relaxed);
	}

	/// Whether an external starts with each of [`SIGNALS`] ignored: when
	/// the process ignores it, or ignored it at load and glibc has given it
	/// a handler since (bash starts no thread, so its children keep it
	/// ignored).
	pub(super) fn ignored() -> [bool; 2] {
		// The address keeps the object holding the load-time reading in
		// every program that spawns.
		let _ = std::hint::black_box(&raw const READ_AT_LOAD);
		let at_load = IGNORED_AT_LOAD.load(Ordering::Relaxed);
		std::array::from_fn(|i| {
			action(SIGNALS[i], None).is_ok_and(|a| {
				let handler = a[HANDLER];
				handler == libc::SIG_IGN || (handler != libc::SIG_DFL && at_load & (1 << i) != 0)
			})
		})
	}

	/// [`ignored`] as the vfork child reads it: bit `n - 1` of the kernel's
	/// signal set for signal `n`, set for each one to start ignored.
	pub(super) fn ignored_bits() -> u64 {
		SIGNALS
			.into_iter()
			.zip(ignored())
			.filter(|&(_, ign)| ign)
			.fold(0, |set, (sig, _)| set | (1 << (sig - 1)))
	}

	/// In a forked child: give the signals the dispositions [`ignored`]
	/// read before the fork. Async-signal-safe.
	pub(super) fn apply(ignored: [bool; 2]) {
		for (sig, ign) in SIGNALS.into_iter().zip(ignored) {
			let handler = if ign { libc::SIG_IGN } else { libc::SIG_DFL };
			let _ = action(sig, Some(&with_handler(handler)));
		}
	}
}

/// Everything `launch` needs besides the fds.
struct Program<'a> {
	path:    &'a [u8],
	argv:    &'a [BString],
	env:     &'a EnvView,
	cwd:     &'a [u8],
	umask:   u32,
	ign:     SigSet,
	/// `(resource, soft, hard)` set in the child before exec.
	rlimits: &'a [(Rlimit, Option<u64>, Option<u64>)],
	/// A foreground job's terminal: the child makes its group the
	/// terminal's foreground before it execs ([`attach_tty`] on the fork
	/// paths).
	tty:     Option<RawFd>,
	/// Targets the child gets closed ([`StdioSpec::Closed`]): each is
	/// installed from a null-device placeholder, then closed.
	closed:  &'a [i32],
}

/// A possible shell text file needs the engine's ENOEXEC retry. The child
/// redirection path cannot report exec errors to the engine after returning
/// its pid, so let the engine open the redirections and attempt the real
/// exec itself instead. This is only a routing hint: the actual exec still
/// decides whether the file is executable and whether fallback is needed.
fn may_need_script_fallback(path: &[u8], cwd: &[u8]) -> bool {
	let path = Path::new(OsStr::from_bytes(path));
	let path = if path.is_absolute() {
		path.to_path_buf()
	} else {
		Path::new(OsStr::from_bytes(cwd)).join(path)
	};
	let Ok(mut file) = fs::OpenOptions::new()
		.read(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(path)
	else {
		return false;
	};
	if !file.metadata().is_ok_and(|m| m.is_file()) {
		return false;
	}
	let mut head = [0u8; 80];
	let Ok(n) = file.read(&mut head) else {
		return false;
	};
	let head = &head[..n];
	!head.starts_with(b"#!")
		&& !head
			.split(|&c| c == b'\n')
			.next()
			.unwrap_or_default()
			.contains(&0)
}

/// The first try of the spawn of `spec` ([`super::NativeSpawner::start`]).
pub(super) fn start(shared: &Arc<Shared>, spec: SpawnSpec<'_>) -> Started {
	try_start(shared, spec).unwrap_or_else(|e| Started::Done(Err(e)))
}

fn try_start(shared: &Arc<Shared>, spec: SpawnSpec<'_>) -> io::Result<Started> {
	let SpawnSpec {
		path,
		argv,
		env,
		cwd,
		stdio,
		extra_fds,
		pgroup,
		umask,
		sigmask_ign,
		rlimits,
		lineage,
		redirs,
		ctty,
		on_busy,
		..
	} = spec;
	if redirs.is_some() && may_need_script_fallback(path, cwd) {
		// The engine retries with its own asynchronous redirection opens.
		return Err(io::Error::other("script requires engine redirection"));
	}
	// A process of a `zpty` session leads a session of its own, without a
	// controlling terminal (it cannot reach the user's terminal through
	// `/dev/tty`; taking the pty as its controlling terminal would hang
	// the pty up for the session when it exits): no group placement
	// applies.
	let place = if ctty.is_some() {
		Place::Session
	} else {
		place(shared.config.sessions, pgroup)?
	};
	let tty = job_terminal(place, pgroup)?;
	let mut pumps = Vec::new();
	let mut feeds = Vec::new();
	let mut fds = Vec::with_capacity(3 + extra_fds.len());
	let mut closed = Vec::new();
	let [stdin, stdout, stderr] = stdio;
	for (target, spec, dir) in [(0, stdin, Dir::In), (1, stdout, Dir::Out), (2, stderr, Dir::Out)] {
		if matches!(spec, StdioSpec::Closed) {
			closed.push(target);
		}
		fds.push((target, child_fd(shared, spec, dir, &mut pumps, &mut feeds)?));
	}
	for (fd, s) in extra_fds {
		if fd < 3 {
			return Err(invalid(format!("extra fd {fd} overlaps stdio")));
		}
		if matches!(s, StdioSpec::Closed) {
			// Not passed: the child has no such descriptor.
			continue;
		}
		fds.push((fd, child_fd(shared, s, Dir::Probe, &mut pumps, &mut feeds)?));
	}
	lift(&mut fds)?;
	let tracker = Tracker::new(pumps.iter().map(Pump::outputs).sum());
	// Polled by the `ExtProc`; dropped (stopping every pump) on any failure
	// below.
	let pumps = Pumps::new(pumps, feeds, &tracker);
	let program =
		Program { path, argv, env, cwd, umask, ign: sigmask_ign, rlimits, tty, closed: &closed };
	let launched = match &redirs {
		Some(redirs) => fork_redirs(&program, &fds, place, redirs, None),
		None => launch(&shared.state, &program, &fds, place),
	};
	// A busy program (`ETXTBSY`), as the spec asks ([`OnBusy`]). `Fail`
	// reports it at once (below); a possible shell text file is waited
	// for here even for `Child` (its exec may yet fail with `ENOEXEC`).
	let launched = match on_busy {
		OnBusy::Child { report, status, exec_diag }
			if redirs.is_none() && is_busy(&launched) && !may_need_script_fallback(path, cwd) =>
		{
			let waits = ChildRedirs { list: Vec::new(), exec_diag };
			fork_redirs(&program, &fds, place, &waits, Some((&report, status)))
		},
		OnBusy::Retry | OnBusy::Child { .. } if redirs.is_none() && is_busy(&launched) => {
			at_busy_wait();
			let kept = Kept { pgroup, lineage, tracker, pumps };
			return Busy::keep(shared, &program, fds, place, kept)
				.map(|busy| Started::Busy(super::Busy(Box::new(busy))));
		},
		_ => launched,
	};
	// Our copies of the child's ends: pumps see end of file when the child
	// (and what it forks) closes its own.
	drop(fds);
	let (pid, place) = launched?;
	Ok(Started::Done(started(shared, pid, place, tty, Kept { pgroup, lineage, tracker, pumps })))
}

/// What a spawn keeps from its preparation for the process it starts.
struct Kept {
	pgroup:  PgroupSpec,
	lineage: crate::bash::Lineage,
	tracker: Arc<Tracker>,
	/// Polled by the `ExtProc`; dropped (stopping every pump) when no
	/// process starts.
	pumps:   Pumps,
}

/// The external `pid`, spawned at `place`: placed, recorded and watched.
fn started(
	shared: &Arc<Shared>,
	pid: i32,
	place: Place,
	tty: Option<RawFd>,
	kept: Kept,
) -> io::Result<Box<dyn ExtProc>> {
	let Kept { pgroup, lineage, tracker, pumps } = kept;
	if let PgroupSpec::Job { .. } = pgroup
		&& let Place::Group(pgid) = place
	{
		// The shell places its job's process too (zsh `addproc`): whichever
		// of the two runs first decides, so a signal to the group or the
		// terminal's next read cannot come before the child is in it. After
		// the child's exec this fails harmlessly (`EACCES`).
		let want = if pgid == 0 { pid } else { pgid };
		// SAFETY: plain syscall without pointer arguments.
		unsafe { libc::setpgid(pid, want) };
		if let Some(tty) = tty {
			attach_tty(tty, want);
		}
	}
	let scope = Scope::of(place, pid);
	// A detached external is meant to outlive the shell: not a leak.
	if !lineage.detached {
		shared.state.record(scope);
	}
	// Parked: the engine thread waits on the pidfd itself (see `Exits::Park`).
	// A job-controlled external has a waiter thread: a pidfd reports its
	// exit, not its stops.
	#[cfg(target_os = "linux")]
	let pidfd =
		if shared.config.exits == super::Exits::Park && !matches!(pgroup, PgroupSpec::Job { .. }) {
			pidfd_open(pid)
		} else {
			None
		};
	#[cfg(target_os = "linux")]
	let parked = pidfd.is_some();
	#[cfg(not(target_os = "linux"))]
	let parked = false;
	if !parked && let Err(e) = watch(pid, Arc::clone(&tracker), Arc::clone(shared)) {
		// Without a waiter nobody would observe the exit: undo the spawn
		// (the child is unreaped, so its scope is still ours).
		let _ = scope.signal(Signal::Kill);
		shared.state.reap(pid);
		return Err(e);
	}
	Ok(Box::new(UnixProc {
		pid,
		scope,
		tracker,
		shared: Arc::clone(shared),
		detached: lineage.detached,
		pumps,
		#[cfg(target_os = "linux")]
		pidfd,
		#[cfg(target_os = "linux")]
		awaited: false,
	}))
}

/// Whether a try failed because the program was busy: a process holds it
/// open for writing (`ETXTBSY`).
fn is_busy<T>(tried: &io::Result<T>) -> bool {
	matches!(tried, Err(e) if e.raw_os_error() == Some(libc::ETXTBSY))
}

/// A spawn on the vfork, `posix_spawn` or fork path whose program was busy
/// ([`super::Started::Busy`]): no process exists. It owns what the next try
/// needs, copied from the spec only for such a spawn: the program's names,
/// the child's descriptors (a copy of each of the engine's own handles,
/// which the engine keeps open only for the spawn call), the pumps and the
/// placement.
pub(super) struct Busy {
	shared:  Arc<Shared>,
	path:    BString,
	argv:    Vec<BString>,
	env:     EnvView,
	cwd:     BString,
	rlimits: Vec<(Rlimit, Option<u64>, Option<u64>)>,
	umask:   u32,
	ign:     SigSet,
	/// A copy of a foreground job's terminal ([`Program::tty`]).
	tty:     Option<OwnedFd>,
	closed:  Vec<i32>,
	fds:     Vec<(i32, Source)>,
	place:   Place,
	kept:    Kept,
}

impl Busy {
	/// The spawn of `prog` at `place` from `fds`, refused as busy, kept for
	/// another try.
	fn keep(
		shared: &Arc<Shared>,
		prog: &Program<'_>,
		mut fds: Vec<(i32, Source)>,
		place: Place,
		kept: Kept,
	) -> io::Result<Self> {
		own(&mut fds)?;
		let tty = prog.tty.map(|tty| dup_above(tty, 3)).transpose()?;
		Ok(Self {
			shared: Arc::clone(shared),
			path: BString::from(prog.path),
			argv: prog.argv.to_vec(),
			env: prog.env.clone(),
			cwd: BString::from(prog.cwd),
			rlimits: prog.rlimits.to_vec(),
			umask: prog.umask,
			ign: prog.ign,
			tty,
			closed: prog.closed.to_vec(),
			fds,
			place,
			kept,
		})
	}

	/// The next try ([`super::Started::settle`]).
	pub(super) fn retry(self) -> Started {
		let launched = launch(&self.shared.state, &self.program(), &self.fds, self.place);
		if is_busy(&launched) {
			at_busy_wait();
			return Started::Busy(super::Busy(Box::new(self)));
		}
		let Self { shared, tty, fds, kept, .. } = self;
		// Our copies of the child's ends, as after a first try.
		drop(fds);
		Started::Done(launched.and_then(|(pid, place)| {
			started(&shared, pid, place, tty.as_ref().map(AsRawFd::as_raw_fd), kept)
		}))
	}

	fn program(&self) -> Program<'_> {
		Program {
			path:    &self.path,
			argv:    &self.argv,
			env:     &self.env,
			cwd:     &self.cwd,
			umask:   self.umask,
			ign:     self.ign,
			rlimits: &self.rlimits,
			tty:     self.tty.as_ref().map(AsRawFd::as_raw_fd),
			closed:  &self.closed,
		}
	}
}

/// Spawn by the best path; returns the pid and the placement that took.
fn launch(
	state: &State,
	prog: &Program<'_>,
	fds: &[(i32, Source)],
	place: Place,
) -> io::Result<(i32, Place)> {
	// `posix_spawn` cannot set resource limits either, nor hand a terminal
	// to the child's group before the exec.
	#[cfg(target_os = "macos")]
	if prog.rlimits.is_empty()
		&& prog.tty.is_none()
		&& state.posix_eligible(prog.umask, prog.ign)
		&& let Some(add_chdir) = state.add_chdir
	{
		let exec = Exec::new(prog)?;
		// `posix_spawn` fails only before the exec: a refused join started
		// nothing.
		return retry_join(
			place,
			|p| posix::spawn(&exec, fds, prog.closed, p, prog.ign, add_chdir),
			|e: &io::Error| e.raw_os_error() == Some(libc::EPERM),
		);
	}
	#[cfg(not(target_os = "macos"))]
	let _ = state;
	#[cfg(target_os = "linux")]
	{
		vfork_exec(prog, fds, place)
	}
	#[cfg(not(target_os = "linux"))]
	fork_exec(prog, fds, place)
}

/// Run `spawn` at `place`; a join that `refused_join` says was refused, its
/// `setpgid` failing with `EPERM` (the group emptied or moved sessions since
/// `joinable`) before anything of the program ran, retries as the leader of
/// a new group. Any other failure, and above all one after the program's
/// exec, is the spawn's: the program is never started twice.
fn retry_join<E>(
	place: Place,
	mut spawn: impl FnMut(Place) -> Result<i32, E>,
	refused_join: impl Fn(&E) -> bool,
) -> Result<(i32, Place), E> {
	match spawn(place) {
		Err(e) if place.joins() && refused_join(&e) => {
			let lead = Place::Group(0);
			spawn(lead).map(|pid| (pid, lead))
		},
		r => r.map(|pid| (pid, place)),
	}
}

thread_local! {
	/// Retain the last exported environment on this spawning thread.
	static EXEC_ENV: RefCell<Option<Arc<ExecEnv>>> = const { RefCell::new(None) };
}

/// Immutable C environment shared by consecutive execs with equal exports.
struct ExecEnv {
	source: EnvView,
	/// Storage kept alive for `ptrs`; never modified after construction.
	_buf:   Vec<u8>,
	ptrs:   Vec<*mut c_char>,
}

// SAFETY: the pointers only read the owned, immutable heap buffer.
unsafe impl Send for ExecEnv {}
// SAFETY: sharing only reads the immutable strings and pointer array.
unsafe impl Sync for ExecEnv {}

impl ExecEnv {
	fn get(env: &EnvView) -> io::Result<Arc<Self>> {
		EXEC_ENV.with_borrow_mut(|cached| {
			if let Some(previous) = cached.as_ref()
				&& previous.source == *env
			{
				return Ok(Arc::clone(previous));
			}
			let len: usize = env.iter().map(|(k, v)| k.len() + v.len() + 2).sum();
			let mut buf = Vec::with_capacity(len);
			let base = buf.as_ptr();
			let mut ptrs = Vec::with_capacity(env.len() + 1);
			for (k, v) in env.iter() {
				let at = push_cstring(&mut buf, &[&**k, b"=", &**v])?;
				// The exact capacity includes every entry's terminating NUL,
				// so appending cannot invalidate this allocation's pointers.
				ptrs.push(base.wrapping_add(at).cast::<c_char>().cast_mut());
			}
			ptrs.push(std::ptr::null_mut());
			let built = Arc::new(Self { source: env.clone(), _buf: buf, ptrs });
			*cached = Some(Arc::clone(&built));
			Ok(built)
		})
	}
}

/// Append one NUL-terminated C string without accepting embedded NULs.
fn push_cstring(buf: &mut Vec<u8>, parts: &[&[u8]]) -> io::Result<usize> {
	if parts.iter().any(|p| p.contains(&0)) {
		return Err(CString::new(parts.concat()).map_or_else(invalid, |_| invalid("NUL byte")));
	}
	let at = buf.len();
	for p in parts {
		buf.extend_from_slice(p);
	}
	buf.push(0);
	Ok(at)
}

/// C arguments built before a fork; retries retain the same environment.
struct Exec {
	/// Arguments, path and cwd, NUL-terminated in one immutable allocation.
	buf:  Vec<u8>,
	path: usize,
	cwd:  usize,
	argv: Vec<*mut c_char>,
	env:  Arc<ExecEnv>,
}

// SAFETY: `argv` points into the owned immutable `buf`, and `env` is immutable.
unsafe impl Send for Exec {}
// SAFETY: shared access only reads the same immutable allocations.
unsafe impl Sync for Exec {}

impl Exec {
	fn new(prog: &Program<'_>) -> io::Result<Self> {
		let env = ExecEnv::get(prog.env)?;
		let arg_len: usize = prog.argv.iter().map(|a| a.len() + 1).sum();
		let mut buf = Vec::with_capacity(arg_len + prog.path.len() + prog.cwd.len() + 2);
		let base = buf.as_ptr();
		let mut argv = Vec::with_capacity(prog.argv.len() + 1);
		for a in prog.argv {
			let at = push_cstring(&mut buf, &[a.as_slice()])?;
			// Capacity covers every string, so the allocation stays put.
			argv.push(base.wrapping_add(at).cast::<c_char>().cast_mut());
		}
		argv.push(std::ptr::null_mut());
		let path = push_cstring(&mut buf, &[prog.path])?;
		let cwd = push_cstring(&mut buf, &[prog.cwd])?;
		Ok(Self { buf, path, cwd, argv, env })
	}

	/// The program's path as a C string.
	fn path(&self) -> *const c_char {
		self.buf[self.path..].as_ptr().cast()
	}

	/// The working directory as a C string.
	fn cwd(&self) -> *const c_char {
		self.buf[self.cwd..].as_ptr().cast()
	}
}

/// The Linux path: a vfork child (`vfork`) that sets up and execs the
/// program from what is prepared here, before the clone. A spawn that failed
/// after the program's exec fails with an error [`vfork::program_ran`] tells
/// apart, and is not retried.
#[cfg(target_os = "linux")]
fn vfork_exec(prog: &Program<'_>, fds: &[(i32, Source)], place: Place) -> io::Result<(i32, Place)> {
	let exec = Exec::new(prog)?;
	let fds: Vec<(i32, RawFd)> = fds.iter().map(|(t, fd)| (*t, fd.as_raw_fd())).collect();
	let limits = limits(prog);
	let ignored_set = ignored(prog.ign)
		.iter()
		.enumerate()
		.skip(1)
		.filter(|&(_, &ign)| ign)
		.fold(0u64, |set, (n, _)| set | (1 << (n - 1)));
	// No `SigSet` holds glibc's own signals: the child gets them as the
	// process has them (`internal`).
	#[cfg(all(
		target_os = "linux",
		target_env = "gnu",
		any(target_arch = "x86_64", target_arch = "aarch64")
	))]
	let ignored_set = ignored_set | internal::ignored_bits();
	let mut child = vfork::Child {
		path:    exec.path(),
		argv:    exec.argv.as_ptr().cast(),
		envp:    exec.env.ptrs.as_ptr().cast(),
		cwd:     exec.cwd(),
		session: false,
		group:   None,
		tty:     prog.tty,
		umask:   prog.umask as libc::mode_t,
		fds:     &fds,
		closed:  prog.closed,
		ignored: ignored_set,
		limits:  &limits,
	};
	// The thread's launcher starts before the spawn: its start allocates.
	vfork::prepare()?;
	retry_join(
		place,
		|p| {
			(child.session, child.group) = match p {
				Place::Session => (true, None),
				Place::Group(pgid) => (false, Some(pgid)),
				Place::Inherit => (false, None),
			};
			// SAFETY: `child` points into `exec`, `fds`, `limits` and `prog`,
			// alive for the call.
			unsafe { vfork::spawn(&child) }
		},
		vfork::Failure::refused_join,
	)
	.map_err(io::Error::from)
}

/// The fork path: std's `Command` (fork, stdio, cwd, process group) plus an
/// async-signal-safe `pre_exec` that finishes the setup and calls `execve`
/// itself. std would `execvp`, whose libc retries a file without `#!` as a
/// `/bin/sh` script; the engine must see `ENOEXEC` instead and run such a
/// script in-engine, like bash.
#[cfg(not(target_os = "linux"))]
fn fork_exec(prog: &Program<'_>, fds: &[(i32, Source)], place: Place) -> io::Result<(i32, Place)> {
	let exec = Exec::new(prog)?;
	let mut cmd = Command::new(OsStr::from_bytes(prog.path));
	cmd.current_dir(OsStr::from_bytes(prog.cwd));
	let stdio = |target: i32| -> io::Result<Stdio> {
		let (_, fd) = fds
			.iter()
			.find(|(t, _)| *t == target)
			.ok_or_else(|| invalid("missing stdio"))?;
		Ok(Stdio::from(fd.as_fd().try_clone_to_owned()?))
	};
	cmd.stdin(stdio(0)?);
	cmd.stdout(stdio(1)?);
	cmd.stderr(stdio(2)?);
	let extra: Vec<(i32, RawFd)> = fds
		.iter()
		.filter(|(t, _)| *t > 2)
		.map(|(t, fd)| (*t, fd.as_raw_fd()))
		.collect();
	let closed = prog.closed.to_vec();
	let ignore = ignored(prog.ign);
	let mask = prog.umask as libc::mode_t;
	let limits = limits(prog);
	let session = place == Place::Session;
	let tty = prog.tty;
	if let Place::Group(pgid) = place {
		cmd.process_group(pgid);
	}
	// SAFETY: the hook runs in the forked child before exec and calls only
	// async-signal-safe functions (umask, dup2, close, signal, setsid,
	// execve) on data prepared before the fork, without allocating.
	unsafe {
		cmd.pre_exec(move || {
			// Use the whole value: a closure naming only `exec.argv` would
			// capture that field (a bare `Vec<*mut c_char>`, not `Send`) instead
			// of the `Exec` whose `Send`/`Sync` covers the pointers.
			let exec = &exec;
			// std placed the child in its group already; it takes the
			// terminal while it still has the shell's dispositions.
			if let Some(tty) = tty {
				attach_tty(tty, libc::getpgrp());
			}
			libc::umask(mask);
			for &(target, src) in &extra {
				if libc::dup2(src, target) < 0 {
					return Err(io::Error::last_os_error());
				}
			}
			for &target in &closed {
				libc::close(target);
			}
			for (n, &ign) in ignore.iter().enumerate().skip(1) {
				let n = n as i32;
				if n == libc::SIGKILL || n == libc::SIGSTOP {
					continue;
				}
				libc::signal(n, if ign { libc::SIG_IGN } else { libc::SIG_DFL });
			}
			if session && libc::setsid() < 0 {
				return Err(io::Error::last_os_error());
			}
			for (res, lim) in &limits {
				if libc::setrlimit(*res, lim) != 0 {
					return Err(io::Error::last_os_error());
				}
			}
			libc::execve(exec.path(), exec.argv.as_ptr().cast(), exec.env.ptrs.as_ptr().cast());
			// Only reached when exec failed: std reports this errno.
			Err(io::Error::last_os_error())
		});
	}
	// The child reports a failure only before its exec: a refused join
	// started nothing.
	retry_join(
		place,
		|p| {
			if let Place::Group(pgid) = p {
				cmd.process_group(pgid);
			}
			// Dropping the `Child` neither waits nor kills; the waiter owns it.
			cmd.spawn().map(|child| child.id() as i32)
		},
		|e: &io::Error| e.raw_os_error() == Some(libc::EPERM),
	)
}

/// The resource limits to set in the child; resources this platform lacks
/// are skipped (bash reported them at `ulimit` time).
fn limits(prog: &Program<'_>) -> Vec<(rlimit::Resource, libc::rlimit)> {
	prog
		.rlimits
		.iter()
		.filter_map(|&(r, soft, hard)| {
			let lim = libc::rlimit { rlim_cur: rlimit::to_raw(soft), rlim_max: rlimit::to_raw(hard) };
			rlimit::resource(r).map(|res| (res, lim))
		})
		.collect()
}

/// The descriptions of `errno` values the forked child of
/// [`fork_redirs`] prints (it must not format or allocate): bash's
/// `strerror` texts, by number.
static ERRNO_TEXT: LazyLock<Vec<Vec<u8>>> = LazyLock::new(|| {
	(0..256)
		.map(|n| {
			crate::bash::diag::strerror(&io::Error::from_raw_os_error(n))
				.as_bytes()
				.to_vec()
		})
		.collect()
});

/// One [`ChildRedir`] with its C path and flags, built before the fork.
enum ChildStep {
	Open { fds: Vec<i32>, path: CString, flags: libc::c_int, mode: libc::mode_t, diag: Vec<u8> },
	Dup { fd: i32, src: i32, diag: Vec<u8> },
	Close { fd: i32 },
	Fail { text: Vec<u8> },
}

impl ChildStep {
	fn new(redir: &ChildRedir) -> io::Result<Self> {
		Ok(match redir {
			ChildRedir::Open { fds, path, flags, mode, diag } => {
				let access = match (flags.contains(OpenFlags::READ), flags.contains(OpenFlags::WRITE)) {
					(true, true) => libc::O_RDWR,
					(false, true) => libc::O_WRONLY,
					_ => libc::O_RDONLY,
				};
				let extra = [
					(OpenFlags::CREATE, libc::O_CREAT),
					(OpenFlags::TRUNC, libc::O_TRUNC),
					(OpenFlags::APPEND, libc::O_APPEND),
					(OpenFlags::EXCL, libc::O_EXCL),
				]
				.iter()
				.filter(|(f, _)| flags.contains(*f))
				.fold(libc::O_NOCTTY, |acc, (_, bit)| acc | bit);
				Self::Open {
					fds:   fds.clone(),
					path:  CString::new(path.to_vec()).map_err(invalid)?,
					flags: access | extra,
					mode:  *mode as libc::mode_t,
					diag:  diag.to_vec(),
				}
			},
			ChildRedir::Dup { fd, src, diag } => {
				Self::Dup { fd: *fd, src: *src, diag: diag.to_vec() }
			},
			ChildRedir::Close { fd } => Self::Close { fd: *fd },
			ChildRedir::Fail { text } => Self::Fail { text: text.to_vec() },
		})
	}
}

/// Write `diag`, the description of `errno` and a newline to fd 2 and exit
/// with `status`: the forked child's report of a failed redirection or
/// exec. Async-signal-safe.
fn child_fail(diag: &[u8], errno: i32, status: i32, texts: &[Vec<u8>]) -> ! {
	let text = usize::try_from(errno)
		.ok()
		.and_then(|n| texts.get(n))
		.map_or(&b"Unknown error"[..], Vec::as_slice);
	child_exit(&[diag, text, b"\n"], status)
}

/// Write `parts` to fd 2 and exit with `status`. Async-signal-safe.
fn child_exit(parts: &[&[u8]], status: i32) -> ! {
	for part in parts {
		// SAFETY: write(2) of a valid buffer; a failure is ignored (nowhere
		// to report it).
		unsafe { libc::write(2, part.as_ptr().cast(), part.len()) };
	}
	// SAFETY: `_exit` ends the forked child without running host code.
	unsafe { libc::_exit(status) }
}

/// Write `text` to fd 2 and exit with `status`: the forked child's report
/// of a program that stayed busy, as the engine renders it
/// ([`OnBusy::Child`]). Async-signal-safe.
fn child_report(text: &[u8], status: i32) -> ! {
	// SAFETY: write(2) of a valid buffer; a failure is ignored (nowhere to
	// report it).
	unsafe { libc::write(2, text.as_ptr().cast(), text.len()) };
	// SAFETY: `_exit` ends the forked child without running host code.
	unsafe { libc::_exit(status) }
}

/// The last OS error number. Async-signal-safe.
fn errno() -> i32 {
	io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// Runs `attempt` again after each wait of [`super::BUSY_WAITS_MS`]
/// (through `wait`) while it fails with `ETXTBSY`; the first other result,
/// or the last `ETXTBSY` once the waits run out. Async-signal-safe when
/// `attempt` and `wait` are: it allocates nothing, so the child of
/// [`fork_redirs`] uses it.
fn retry_busy<T>(
	mut attempt: impl FnMut() -> io::Result<T>,
	mut wait: impl FnMut(u64),
) -> io::Result<T> {
	let mut waits = super::BUSY_WAITS_MS.iter();
	loop {
		match attempt() {
			Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => match waits.next() {
				Some(&ms) => wait(ms),
				None => return Err(e),
			},
			done => return done,
		}
	}
}

#[cfg(test)]
thread_local! {
	/// A process a test kills when a spawn on this thread, or the child of
	/// [`fork_redirs`] forked from it (which inherits the value), finds its
	/// program busy ([`at_busy_wait`]): the stand-in for another session's
	/// child that lets go of a program by its exec, or a sign the test
	/// waits for.
	pub(super) static KILL_AT_BUSY_WAIT: std::cell::Cell<libc::pid_t> =
		const { std::cell::Cell::new(0) };
	/// Whether the process that waits for a busy program stops itself
	/// (`SIGSTOP`) at its first wait: the child of [`fork_redirs`] forked
	/// from this thread inherits it, and a test reads the stopped child.
	pub(super) static STOP_AT_BUSY_WAIT: std::cell::Cell<bool> =
		const { std::cell::Cell::new(false) };
	/// How many exec tries of the child of [`fork_redirs`] forked from this
	/// thread (which inherits the value) report the program busy without
	/// trying ([`fake_busy`]): a busy program on any kernel, gVisor's too,
	/// which runs a program held open for writing.
	pub(super) static FAKE_BUSY_EXECS: std::cell::Cell<u32> =
		const { std::cell::Cell::new(0) };
	/// A pipe a test reads ([`at_busy_wait`]): the process that waits for a
	/// busy program writes its pid there at each wait, so a test sees which
	/// process waited. A child forked from this thread inherits it.
	pub(super) static BUSY_WAIT_REPORT: std::cell::Cell<RawFd> =
		const { std::cell::Cell::new(-1) };
}

/// In tests, whether this exec try reports the program busy without trying
/// ([`FAKE_BUSY_EXECS`]). Async-signal-safe.
#[cfg(test)]
fn fake_busy() -> bool {
	FAKE_BUSY_EXECS.with(|left| {
		left
			.get()
			.checked_sub(1)
			.inspect(|n| left.set(*n))
			.is_some()
	})
}

/// Outside tests, no exec try is reported busy without trying.
#[cfg(not(test))]
const fn fake_busy() -> bool {
	false
}

/// A spawn found its program busy and is about to wait: in tests, kill the
/// process [`KILL_AT_BUSY_WAIT`] names, once, write this process's pid to
/// [`BUSY_WAIT_REPORT`], and stop this process if [`STOP_AT_BUSY_WAIT`]
/// says so, once. Async-signal-safe.
#[cfg(test)]
fn at_busy_wait() {
	KILL_AT_BUSY_WAIT.with(|holder| {
		let pid = holder.replace(0);
		if pid > 0 {
			// SAFETY: a plain syscall on the test's own child.
			unsafe { libc::kill(pid, libc::SIGKILL) };
		}
	});
	let report = BUSY_WAIT_REPORT.get();
	if report >= 0 {
		// SAFETY: getpid and a write of a local buffer to the test's pipe.
		unsafe {
			let pid = libc::getpid().to_ne_bytes();
			libc::write(report, pid.as_ptr().cast(), pid.len());
		}
	}
	if STOP_AT_BUSY_WAIT.with(|stop| stop.replace(false)) {
		// SAFETY: a plain syscall on this process.
		unsafe { libc::kill(libc::getpid(), libc::SIGSTOP) };
	}
}

/// Outside tests, a spawn about to wait for a busy program does nothing
/// more.
#[cfg(not(test))]
const fn at_busy_wait() {}

/// Sleeps `ms` milliseconds, again for what is left after a signal, in the
/// child of [`fork_redirs`]. Async-signal-safe (`nanosleep`).
fn busy_wait(ms: u64) {
	at_busy_wait();
	let mut left = libc::timespec {
		tv_sec:  (ms / 1000) as libc::time_t,
		tv_nsec: ((ms % 1000) * 1_000_000) as libc::c_long,
	};
	// SAFETY: nanosleep with valid timespecs; it writes what is left on a
	// signal, which the next call sleeps.
	while unsafe { libc::nanosleep(&raw const left, &raw mut left) } != 0 && errno() == libc::EINTR {
	}
}

/// Close every descriptor marked close-on-exec: what an exec would close.
/// The child of [`fork_redirs`] does it before it waits for a busy
/// program, so that while it waits it holds only the descriptors the
/// program will (not another job's pipe, nor a program another session is
/// writing). Async-signal-safe, without allocation: on Linux it reads the
/// list of `/proc/self/fd`; elsewhere, or without `/proc`, it asks each
/// number below `fd_bound`.
///
/// # Safety
///
/// For the forked child only: it closes descriptors other code of this
/// process may hold.
unsafe fn close_on_exec(fd_bound: i32) {
	#[cfg(target_os = "linux")]
	// SAFETY: as this function's.
	if unsafe { close_listed_on_exec() } {
		return;
	}
	for fd in 0..fd_bound {
		// SAFETY: as this function's.
		unsafe { close_if_on_exec(fd) };
	}
}

/// Close `fd` if it is marked close-on-exec.
///
/// # Safety
///
/// As [`close_on_exec`]'s.
unsafe fn close_if_on_exec(fd: i32) {
	// SAFETY: fcntl and close take scalars.
	unsafe {
		let flags = libc::fcntl(fd, libc::F_GETFD);
		if flags >= 0 && flags & libc::FD_CLOEXEC != 0 {
			libc::close(fd);
		}
	}
}

/// [`close_on_exec`] over the descriptors `/proc/self/fd` lists; `false`
/// when it could not read the whole list.
///
/// # Safety
///
/// As [`close_on_exec`]'s.
#[cfg(target_os = "linux")]
unsafe fn close_listed_on_exec() -> bool {
	// SAFETY: open of a NUL-terminated path; the result is checked.
	let dir = unsafe {
		libc::open(c"/proc/self/fd".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
	};
	if dir < 0 {
		return false;
	}
	// `linux_dirent64` records, 8-byte aligned.
	let mut buf = [0u64; 512];
	let listed = loop {
		// SAFETY: getdents64 writes at most the buffer's size into it.
		let n = unsafe {
			libc::syscall(libc::SYS_getdents64, dir, buf.as_mut_ptr(), std::mem::size_of_val(&buf))
		};
		let Ok(n) = usize::try_from(n) else {
			break false;
		};
		if n == 0 {
			break true;
		}
		// SAFETY: the kernel wrote `n` bytes of records into `buf`.
		let records = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), n) };
		let mut at = 0;
		// Each record: inode (8 bytes), offset (8), length (2), type (1),
		// then the NUL-terminated name.
		while let Some(record) = records.get(at..)
			&& let Some(&[lo, hi]) = record.get(16..18)
		{
			let len = usize::from(u16::from_ne_bytes([lo, hi]));
			let Some(name) = record.get(19..len) else {
				break;
			};
			if let Some(fd) = fd_number(name)
				&& fd != dir
			{
				// SAFETY: as this function's.
				unsafe { close_if_on_exec(fd) };
			}
			at += len;
		}
	};
	// SAFETY: closes the descriptor opened above.
	unsafe { libc::close(dir) };
	listed
}

/// The descriptor a `/proc/self/fd` entry names (its NUL-terminated decimal
/// name); `None` for `.` and `..`.
#[cfg(target_os = "linux")]
fn fd_number(name: &[u8]) -> Option<i32> {
	let digits = name.split(|&b| b == 0).next()?;
	if digits.is_empty() {
		return None;
	}
	digits.iter().try_fold(0i32, |fd, &b| {
		let digit = b.checked_sub(b'0').filter(|d| *d <= 9)?;
		fd.checked_mul(10)?.checked_add(i32::from(digit))
	})
}

/// The spawn of a process that applies redirections itself
/// ([`ChildRedirs`]): a bare `fork` whose child installs its fds, applies
/// the redirections in order (an open may wait for a FIFO's other end:
/// only the child waits, as bash's does) and execs; on Linux it sets its
/// OOM adjustment first, as the vfork child does. The parent returns at
/// once with the pid; a failure in the child is reported on its own fd 2
/// and its exit status (1 for a redirection, 127 or 126 for the exec). A
/// `busy` report `(text, status)` replaces the exec failure's when the last
/// try still finds the program busy ([`OnBusy::Child`]).
fn fork_redirs(
	prog: &Program<'_>,
	fds: &[(i32, Source)],
	place: Place,
	redirs: &ChildRedirs,
	busy: Option<(&[u8], u8)>,
) -> io::Result<(i32, Place)> {
	let exec = Exec::new(prog)?;
	let steps = redirs
		.list
		.iter()
		.map(ChildStep::new)
		.collect::<io::Result<Vec<_>>>()?;
	let exec_diag = redirs.exec_diag.to_vec();
	let busy = busy.map(|(text, status)| (text.to_vec(), i32::from(status)));
	let texts: &[Vec<u8>] = &ERRNO_TEXT;
	// The bound of the child's close loop where `/proc` cannot list its
	// descriptors ([`close_on_exec`]), read here: the child must not
	// allocate.
	// SAFETY: sysconf takes a constant and reads no memory of ours.
	let fd_bound = i32::try_from(unsafe { libc::sysconf(libc::_SC_OPEN_MAX) })
		.ok()
		.filter(|&n| n > 0)
		.unwrap_or(1 << 16);
	let ignore = ignored(prog.ign);
	#[cfg(all(
		target_os = "linux",
		target_env = "gnu",
		any(target_arch = "x86_64", target_arch = "aarch64")
	))]
	let glibc_ignored = internal::ignored();
	let mask = prog.umask as libc::mode_t;
	let limits = limits(prog);
	let raw: Vec<(i32, RawFd)> = fds.iter().map(|(t, fd)| (*t, fd.as_raw_fd())).collect();
	let closed = prog.closed;
	// What the child keeps of the descriptors it inherits from the host
	// ([`close_all_but`]), how it closes the rest, and the bound of its
	// counting loop, decided here: the child must not allocate.
	let keep = kept_fds(&raw, closed, &open_without_cloexec());
	// The kept ones that are the host's own, not placed: listed before the
	// fork, so the child checks each again ([`close_reused`]).
	let inherited: Vec<i32> = keep
		.iter()
		.copied()
		.filter(|&fd| !raw.iter().any(|&(target, _)| target == fd))
		.collect();
	let open_max = open_max();
	let sweep = sweep();
	#[cfg(test)]
	if let Some(f) = BEFORE_FORK.with(|b| b.borrow_mut().take()) {
		f();
	}
	// Every signal stays blocked across the fork: the child runs with the
	// host's handlers until it resets them, and a signal delivered then (a
	// `kill $!` right after the spawn) would run host code and be lost
	// while the child goes on to wait in a FIFO open. Blocked, it stays
	// pending until the child's dispositions are the program's.
	// SAFETY: sigset_t is plain data; the calls only read and write the
	// sets passed.
	let old = unsafe {
		let mut all = std::mem::zeroed::<libc::sigset_t>();
		let mut old = std::mem::zeroed::<libc::sigset_t>();
		libc::sigfillset(&raw mut all);
		libc::pthread_sigmask(libc::SIG_BLOCK, &raw const all, &raw mut old);
		old
	};
	// SAFETY: the child calls only async-signal-safe functions on data
	// prepared above, without allocating, and ends in `execve` or `_exit`.
	let pid = unsafe { libc::fork() };
	if pid != 0 {
		// SAFETY: restores the mask saved above.
		unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &raw const old, std::ptr::null_mut()) };
	}
	if pid < 0 {
		return Err(io::Error::last_os_error());
	}
	if pid == 0 {
		// SAFETY: as above (the forked child).
		unsafe {
			// A fork child has memory of its own: the write changes only its
			// value.
			#[cfg(target_os = "linux")]
			pi_builtins::prefer_oom_kill();
			match place {
				Place::Session => {
					libc::setsid();
				},
				// A refused join leads a group of its own (as `retry_join`).
				Place::Group(pgid) => {
					if libc::setpgid(0, pgid) < 0 && pgid != 0 {
						libc::setpgid(0, 0);
					}
					if let Some(tty) = prog.tty {
						attach_tty(tty, libc::getpgrp());
					}
				},
				Place::Inherit => {},
			}
			if libc::chdir(exec.cwd()) != 0 {
				child_fail(&exec_diag, errno(), 126, texts);
			}
			for &(target, src) in &raw {
				if libc::dup2(src, target) < 0 {
					child_fail(&exec_diag, errno(), 126, texts);
				}
			}
			for &target in closed {
				libc::close(target);
			}
			// Before any redirection, close what the exec would close (every
			// host descriptor with close-on-exec but the placed ones), as bash's
			// child holds none of them: an open that waits (a FIFO's other end)
			// would otherwise hold the host's own descriptors until the exec,
			// other jobs' pipe ends among them, so their readers would wait for
			// this open (bash's parent keeps no end of another job's pipe).
			close_all_but(&keep, open_max, sweep);
			close_reused(&inherited);
			libc::umask(mask);
			for (n, &ign) in ignore.iter().enumerate().skip(1) {
				let n = n as i32;
				if n == libc::SIGKILL || n == libc::SIGSTOP {
					continue;
				}
				libc::signal(n, if ign { libc::SIG_IGN } else { libc::SIG_DFL });
			}
			#[cfg(all(
				target_os = "linux",
				target_env = "gnu",
				any(target_arch = "x86_64", target_arch = "aarch64")
			))]
			internal::apply(glibc_ignored);
			// Only now may pending signals arrive: they act as on the program.
			let empty = std::mem::zeroed::<libc::sigset_t>();
			libc::sigprocmask(libc::SIG_SETMASK, &raw const empty, std::ptr::null_mut());
			for (res, lim) in &limits {
				if libc::setrlimit(*res, lim) != 0 {
					child_fail(&exec_diag, errno(), 126, texts);
				}
			}
			for step in &steps {
				match step {
					ChildStep::Open { fds, path, flags, mode, diag } => {
						let fd = libc::open(path.as_ptr(), *flags, libc::c_uint::from(*mode));
						if fd < 0 {
							child_fail(diag, errno(), 1, texts);
						}
						for &target in fds {
							if target != fd && libc::dup2(fd, target) < 0 {
								child_fail(diag, errno(), 1, texts);
							}
						}
						if !fds.contains(&fd) {
							libc::close(fd);
						}
					},
					ChildStep::Dup { fd, src, diag } => {
						if libc::dup2(*src, *fd) < 0 {
							child_fail(diag, errno(), 1, texts);
						}
					},
					ChildStep::Close { fd } => {
						libc::close(*fd);
					},
					ChildStep::Fail { text } => child_exit(&[text.as_slice()], 1),
				}
			}
			// A busy program is tried again ([`super::BUSY_WAITS_MS`]). The
			// parent does not wait for this exec (this process is `$!`, its
			// opens are done), so this child waits, and first closes what
			// the exec would: while it waits it holds only the descriptors
			// the program will.
			let mut closed_on_exec = false;
			let e = retry_busy::<()>(
				|| {
					if fake_busy() {
						return Err(io::Error::from_raw_os_error(libc::ETXTBSY));
					}
					libc::execve(exec.path(), exec.argv.as_ptr().cast(), exec.env.ptrs.as_ptr().cast());
					Err(io::Error::last_os_error())
				},
				|ms| {
					if !closed_on_exec {
						close_on_exec(fd_bound);
						closed_on_exec = true;
					}
					busy_wait(ms);
				},
			)
			.err()
			.and_then(|e| e.raw_os_error())
			.unwrap_or(0);
			if e == libc::ETXTBSY
				&& let Some((text, status)) = &busy
			{
				child_report(text, *status);
			}
			child_fail(&exec_diag, e, if e == libc::ENOENT { 127 } else { 126 }, texts);
		}
	}
	// The parent places the child too, so a signal to its group cannot
	// come before it joined; whichever of the two runs first decides.
	let place = match place {
		Place::Group(pgid) => {
			let want = if pgid == 0 { pid } else { pgid };
			// SAFETY: plain syscalls without pointer arguments.
			unsafe {
				if libc::setpgid(pid, want) < 0 && pgid != 0 {
					libc::setpgid(pid, pid);
				}
				if pgid != 0 && libc::getpgid(pid) == pid {
					Place::Group(0)
				} else {
					place
				}
			}
		},
		other => other,
	};
	Ok((pid, place))
}

/// The descriptors the child of [`fork_redirs`] keeps, as bash's child
/// does: the placed `targets` (stdio and extra fds) and every host
/// descriptor without close-on-exec (`inherited`, listed before the fork; a
/// vfork, `posix_spawn` or fork+exec child keeps those too, such as a make
/// jobserver's pipe), but the `closed` ones. So the child closes early only
/// what its exec would close. Every source a redirection may read is one of
/// these or an fd an earlier redirection opened. Sorted, unique.
fn kept_fds(targets: &[(i32, RawFd)], closed: &[i32], inherited: &[i32]) -> Vec<i32> {
	let mut keep: Vec<i32> = targets
		.iter()
		.map(|&(target, _)| target)
		.chain(inherited.iter().copied())
		.filter(|fd| !closed.contains(fd))
		.collect();
	keep.sort_unstable();
	keep.dedup();
	keep
}

/// Close each of `inherited` (the host's descriptors the child of
/// [`fork_redirs`] keeps, listed before the fork) that has close-on-exec
/// now: another thread closed the one listed, and a new descriptor took the
/// number before the fork (another job's pipe end, say). The exec would
/// close it, so the child must not hold it while its open waits.
/// Async-signal-safe, without allocation.
///
/// # Safety
///
/// Only in the forked child of [`fork_redirs`].
unsafe fn close_reused(inherited: &[i32]) {
	for &fd in inherited {
		// SAFETY: F_GETFD only reads the descriptor's flags.
		let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
		if flags != -1 && flags & libc::FD_CLOEXEC != 0 {
			// SAFETY: closes a descriptor of the child's own table.
			unsafe { libc::close(fd) };
		}
	}
}

#[cfg(test)]
thread_local! {
	static BEFORE_FORK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
		const { std::cell::RefCell::new(None) };
}

/// Tests: the next [`fork_redirs`] on this thread runs `f` after it lists
/// the host's descriptors and before it forks, the window [`close_reused`]
/// covers.
#[cfg(test)]
fn before_fork(f: impl FnOnce() + 'static) {
	BEFORE_FORK.with(|b| *b.borrow_mut() = Some(Box::new(f)));
}

/// The host's open descriptors above 2 without close-on-exec, now (Linux:
/// `/proc/self/fd`; elsewhere `/dev/fd`). None where neither can be read:
/// the child then closes those too.
fn open_without_cloexec() -> Vec<i32> {
	let mut fds = Vec::new();
	#[cfg(any(target_os = "linux", target_os = "android"))]
	{
		// SAFETY: the path is terminated; open makes a descriptor of ours.
		let dir = unsafe {
			libc::open(c"/proc/self/fd".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
		};
		if dir >= 0 {
			let mut buf = [0u8; 1024];
			// SAFETY: `dir` is an open directory descriptor of ours.
			while let Some(n) = unsafe { fd_batch(dir, &mut buf, |fd| fds.push(fd)) }
				&& n > 0
			{}
			// SAFETY: closes the descriptor opened above.
			unsafe { libc::close(dir) };
			fds.retain(|&fd| fd != dir);
		}
	}
	#[cfg(not(any(target_os = "linux", target_os = "android")))]
	if let Ok(entries) = std::fs::read_dir("/dev/fd") {
		fds.extend(entries.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<i32>().ok()));
	}
	fds.retain(|&fd| {
		// SAFETY: F_GETFD only reads the descriptor flags (fails for the
		// listing's own descriptor, closed by now).
		let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
		fd > 2 && flags != -1 && flags & libc::FD_CLOEXEC == 0
	});
	fds
}

/// The bound of [`count_close`]'s loop: the process's descriptor limit.
fn open_max() -> i32 {
	// SAFETY: sysconf takes a constant and reads no memory of ours.
	let n = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
	if n <= 0 {
		1 << 16
	} else {
		i32::try_from(n).unwrap_or(i32::MAX)
	}
}

/// How the child of [`fork_redirs`] closes the host's descriptors:
/// `close_range` over the gaps between the kept ones (Linux 5.9 and later);
/// else each descriptor `/proc/self/fd` lists (a kernel without
/// `close_range`, or a seccomp profile that refuses it); else every number
/// below the descriptor limit (no `/proc`, and macOS). Tests force the
/// slower ways (`force_sweep`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sweep {
	CloseRange,
	#[cfg_attr(not(test), allow(dead_code, reason = "only tests start the sweep past close_range"))]
	Walk,
	#[cfg_attr(not(test), allow(dead_code, reason = "only tests start the sweep past close_range"))]
	Count,
}

#[cfg(test)]
thread_local! {
	static FORCED_SWEEP: std::cell::Cell<Sweep> = const { std::cell::Cell::new(Sweep::CloseRange) };
}

/// Tests: the children this thread spawns next start their sweep at
/// `sweep` (each falls back from there as in production).
#[cfg(test)]
fn force_sweep(sweep: Sweep) {
	FORCED_SWEEP.with(|s| s.set(sweep));
}

/// Where the next child's sweep starts ([`Sweep`]).
#[cfg_attr(
	not(test),
	allow(clippy::missing_const_for_fn, reason = "tests read a thread-local here")
)]
fn sweep() -> Sweep {
	#[cfg(test)]
	return FORCED_SWEEP.with(std::cell::Cell::get);
	#[cfg(not(test))]
	Sweep::CloseRange
}

/// Close every descriptor above 2 but those in `keep` (sorted), in the
/// forked child of [`fork_redirs`], starting at `sweep` ([`Sweep`]).
/// Async-signal-safe, without allocation.
///
/// # Safety
///
/// For the forked child only: it closes descriptors other code of this
/// process may hold.
unsafe fn close_all_but(keep: &[i32], open_max: i32, sweep: Sweep) {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	{
		// SAFETY: as this function's.
		if sweep == Sweep::CloseRange && unsafe { close_range_all_but(keep) } {
			return;
		}
		// SAFETY: as this function's.
		if sweep != Sweep::Count && unsafe { walk_close(keep) } {
			return;
		}
	}
	#[cfg(not(any(target_os = "linux", target_os = "android")))]
	let _ = sweep;
	// SAFETY: as this function's.
	unsafe { count_close(keep, open_max) };
}

/// `close_range` over each gap between the descriptors in `keep` (sorted);
/// false as soon as the kernel refuses it.
///
/// # Safety
///
/// As [`close_all_but`]'s.
#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn close_range_all_but(keep: &[i32]) -> bool {
	let range = |first: i32, last: i32| {
		first > last
			// SAFETY: close_range takes scalars; it only closes descriptors.
			|| unsafe {
				libc::syscall(libc::SYS_close_range, first as libc::c_uint, last as libc::c_uint, 0 as libc::c_uint)
			} == 0
	};
	let mut first = 3;
	for &kept in keep {
		if kept >= first {
			if !range(first, kept - 1) {
				return false;
			}
			first = kept + 1;
		}
	}
	range(first, i32::MAX)
}

/// Close each descriptor above 2 that `/proc/self/fd` lists but those in
/// `keep` (sorted), reading the directory with `getdents64` into a buffer on
/// the stack (glibc's `closefrom` fallback works this way); false when the
/// directory cannot be read. A pass that closed something reads the
/// directory again from the start, so no entry is skipped.
///
/// # Safety
///
/// As [`close_all_but`]'s.
#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn walk_close(keep: &[i32]) -> bool {
	// SAFETY: the path is terminated; open makes a descriptor of ours.
	let dir = unsafe {
		libc::open(c"/proc/self/fd".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
	};
	if dir < 0 {
		return false;
	}
	let mut buf = [0u8; 1024];
	let read = loop {
		let mut closed = false;
		let pass = loop {
			// SAFETY: `dir` is an open directory descriptor; close takes a
			// scalar.
			let batch = unsafe {
				fd_batch(dir, &mut buf, |fd| {
					if fd > 2 && fd != dir && keep.binary_search(&fd).is_err() {
						libc::close(fd);
						closed = true;
					}
				})
			};
			match batch {
				Some(0) => break true,
				Some(_) => {},
				None => break false,
			}
		};
		if !pass || !closed {
			break pass;
		}
		// SAFETY: rewinds the directory descriptor opened above.
		unsafe { libc::lseek(dir, 0, libc::SEEK_SET) };
	};
	// SAFETY: closes the descriptor opened above.
	unsafe { libc::close(dir) };
	read
}

/// One `getdents64` batch of the descriptor directory `dir` read into
/// `buf`, calling `each` with every descriptor number it lists: `Some` of
/// the bytes read (0 at the end), `None` on an error. Allocates nothing: the
/// forked child walks with it.
///
/// # Safety
///
/// `dir` must be an open directory descriptor.
#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn fd_batch(dir: RawFd, buf: &mut [u8], mut each: impl FnMut(i32)) -> Option<usize> {
	let n = loop {
		// SAFETY: getdents64 writes at most `buf.len()` bytes into `buf`.
		let n = unsafe { libc::syscall(libc::SYS_getdents64, dir, buf.as_mut_ptr(), buf.len()) };
		if n < 0 && errno() == libc::EINTR {
			continue;
		}
		break n;
	};
	let n = usize::try_from(n).ok()?;
	let mut entries = &buf[..n];
	// linux_dirent64: two u64 fields, a u16 record length, a u8 type, then
	// the NUL-terminated name, whatever the userspace ABI.
	while entries.len() >= 20 {
		let len = usize::from(u16::from_ne_bytes([entries[16], entries[17]]));
		if len < 20 || len > entries.len() {
			return None;
		}
		let mut fd: i32 = 0;
		let mut digits = 0;
		for &b in &entries[19..len] {
			if !b.is_ascii_digit() {
				break;
			}
			fd = fd.saturating_mul(10).saturating_add(i32::from(b - b'0'));
			digits += 1;
		}
		if digits > 0 && entries[..len].get(19 + digits) == Some(&0) {
			each(fd);
		}
		entries = &entries[len..];
	}
	Some(n)
}

/// Close every number above 2 below `open_max` but those in `keep`
/// (sorted): the last resort, where no descriptor list can be read.
///
/// # Safety
///
/// As [`close_all_but`]'s.
unsafe fn count_close(keep: &[i32], open_max: i32) {
	let mut kept = keep.iter().peekable();
	for fd in 3..open_max {
		while kept.next_if(|&&k| k < fd).is_some() {}
		if kept.peek() == Some(&&fd) {
			continue;
		}
		// SAFETY: close takes a scalar.
		unsafe { libc::close(fd) };
	}
}

#[cfg(target_os = "macos")]
mod posix {
	use std::{cell::RefCell, io, mem::MaybeUninit, os::fd::AsRawFd};

	thread_local! {
		/// Reusable actions for this thread's last descriptor map and cwd.
		/// The actions contain descriptor numbers, not open-file ownership:
		/// a later spawn always duplicates the descriptors it currently has.
		static ACTIONS: RefCell<Option<Actions>> = const { RefCell::new(None) };
		/// Rebuild attributes only when placement or signal dispositions change.
		static ATTRS: RefCell<Option<(Place, SigSet, u64, Attr)>> = const { RefCell::new(None) };
	}

	/// The cached action list and the inputs that completely describe it.
	struct Actions {
		raw:    FileActions,
		fds:    Vec<(i32, i32)>,
		closed: Vec<i32>,
		cwd:    Vec<u8>,
	}

	impl Actions {
		fn matches(&self, exec: &Exec, fds: &[(i32, Source)], closed: &[i32]) -> bool {
			self.cwd == exec.buf[exec.cwd..]
				&& self.closed == closed
				&& self.fds.len() == fds.len()
				&& self
					.fds
					.iter()
					.zip(fds)
					.all(|(&(target, source), (want, fd))| target == *want && source == fd.as_raw_fd())
		}

		fn new(
			exec: &Exec,
			fds: &[(i32, Source)],
			closed: &[i32],
			add_chdir: AddChdir,
		) -> io::Result<Self> {
			let mut raw = FileActions::new()?;
			for (target, fd) in fds {
				// SAFETY: initialized actions; descriptors are plain integers.
				check(unsafe {
					libc::posix_spawn_file_actions_adddup2(raw.ptr(), fd.as_raw_fd(), *target)
				})?;
			}
			for &target in closed {
				// SAFETY: initialized actions; `target` is a plain integer.
				check(unsafe { libc::posix_spawn_file_actions_addclose(raw.ptr(), target) })?;
			}
			// SAFETY: initialized actions; libc copies the NUL-terminated cwd.
			check(unsafe { add_chdir(raw.ptr(), exec.cwd()) })?;
			Ok(Self {
				raw,
				fds: fds
					.iter()
					.map(|(target, fd)| (*target, fd.as_raw_fd()))
					.collect(),
				closed: closed.to_vec(),
				cwd: exec.buf[exec.cwd..].to_vec(),
			})
		}
	}

	use std::sync::atomic::Ordering;

	use super::{DISPOSITIONS, Exec, Place, Source, host_ignored, ignored};
	use crate::bash::SigSet;

	pub(super) type AddChdir = unsafe extern "C" fn(
		*mut libc::posix_spawn_file_actions_t,
		*const libc::c_char,
	) -> libc::c_int;

	#[allow(
		clippy::unnecessary_wraps,
		reason = "tests exercise the fallback without this extension"
	)]
	pub(super) const fn add_chdir() -> Option<AddChdir> {
		Some(libc::posix_spawn_file_actions_addchdir_np)
	}

	/// `POSIX_SPAWN_SETSID` (`<sys/spawn.h>`, macOS 10.15+; absent from the
	/// libc crate).
	const SETSID: libc::c_int = 0x0400;

	fn check(rc: libc::c_int) -> io::Result<()> {
		if rc == 0 {
			Ok(())
		} else {
			Err(io::Error::from_raw_os_error(rc))
		}
	}

	/// `posix_spawn` `exec` with `fds` installed and the targets `closed`
	/// closed after, at `place`, with every signal not in `ign` at its
	/// default: the ones the host ignores are reset (`exec` resets caught
	/// ones; glibc's child spends a `sigaction` on each signal of the set).
	/// `add_chdir` is the resolved libc entry point, one value for the
	/// process, so the cached action list does not key on it.
	pub fn spawn(
		exec: &Exec,
		fds: &[(i32, Source)],
		closed: &[i32],
		place: Place,
		ign: SigSet,
		add_chdir: AddChdir,
	) -> io::Result<i32> {
		ACTIONS.with_borrow_mut(|cached| {
			if !cached
				.as_ref()
				.is_some_and(|actions| actions.matches(exec, fds, closed))
			{
				*cached = Some(Actions::new(exec, fds, closed, add_chdir)?);
			}
			let actions = &mut cached.as_mut().expect("initialized actions").raw;
			ATTRS.with_borrow_mut(|cached| {
				let generation = DISPOSITIONS.load(Ordering::Acquire);
				if !cached
					.as_ref()
					.is_some_and(|(p, i, g, _)| *p == place && *i == ign && *g == generation)
				{
					*cached = Some((place, ign, generation, Attr::for_child(place, ign)?));
				}
				let attr = &mut cached.as_mut().expect("initialized attributes").3;
				let mut pid: libc::pid_t = 0;
				// SAFETY: every pointer is valid for the call: NUL-terminated
				// strings owned by `exec`, NULL-terminated pointer arrays, and
				// initialized actions and attributes.
				check(unsafe {
					libc::posix_spawn(
						&raw mut pid,
						exec.path(),
						actions.ptr(),
						attr.ptr(),
						exec.argv.as_ptr(),
						exec.env.ptrs.as_ptr(),
					)
				})?;
				Ok(pid)
			})
		})
	}

	/// Initialized `posix_spawn_file_actions_t`, destroyed on drop.
	struct FileActions(MaybeUninit<libc::posix_spawn_file_actions_t>);

	impl FileActions {
		fn new() -> io::Result<Self> {
			let mut fa = MaybeUninit::uninit();
			// SAFETY: init writes the object; only an initialized one is
			// wrapped (and destroyed on drop).
			check(unsafe { libc::posix_spawn_file_actions_init(fa.as_mut_ptr()) })?;
			Ok(Self(fa))
		}

		const fn ptr(&mut self) -> *mut libc::posix_spawn_file_actions_t {
			self.0.as_mut_ptr()
		}
	}

	impl Drop for FileActions {
		fn drop(&mut self) {
			// SAFETY: initialized in `new`.
			unsafe { libc::posix_spawn_file_actions_destroy(self.0.as_mut_ptr()) };
		}
	}

	/// Initialized `posix_spawnattr_t`, destroyed on drop.
	struct Attr(MaybeUninit<libc::posix_spawnattr_t>);

	impl Attr {
		fn new() -> io::Result<Self> {
			let mut a = MaybeUninit::uninit();
			// SAFETY: init writes the object; only an initialized one is
			// wrapped (and destroyed on drop).
			check(unsafe { libc::posix_spawnattr_init(a.as_mut_ptr()) })?;
			Ok(Self(a))
		}

		fn for_child(place: Place, ign: SigSet) -> io::Result<Self> {
			let mut attr = Self::new()?;
			let mut flags = libc::POSIX_SPAWN_SETSIGMASK | libc::POSIX_SPAWN_SETSIGDEF;
			match place {
				Place::Session => flags |= SETSID,
				Place::Group(pgid) => {
					flags |= libc::POSIX_SPAWN_SETPGROUP;
					// SAFETY: `attr` is initialized.
					check(unsafe { libc::posix_spawnattr_setpgroup(attr.ptr(), pgid) })?;
				},
				Place::Inherit => {},
			}
			flags |= libc::POSIX_SPAWN_CLOEXEC_DEFAULT;
			// SAFETY: sigset_t is plain data, initialized by sigemptyset below.
			let mut empty: libc::sigset_t = unsafe { std::mem::zeroed() };
			// SAFETY: as above.
			let mut defaults: libc::sigset_t = unsafe { std::mem::zeroed() };
			let ignore = ignored(ign);
			let host = host_ignored();
			// SAFETY: both sets are valid, writable sigset_t values.
			unsafe {
				libc::sigemptyset(&raw mut empty);
				libc::sigemptyset(&raw mut defaults);
				for (n, (&host, &ign)) in host.iter().zip(&ignore).enumerate().skip(1) {
					if host && !ign {
						libc::sigaddset(&raw mut defaults, n as i32);
					}
				}
				check(libc::posix_spawnattr_setflags(attr.ptr(), flags as libc::c_short))?;
				check(libc::posix_spawnattr_setsigmask(attr.ptr(), &raw const empty))?;
				check(libc::posix_spawnattr_setsigdefault(attr.ptr(), &raw const defaults))?;
			}
			Ok(attr)
		}

		const fn ptr(&mut self) -> *mut libc::posix_spawnattr_t {
			self.0.as_mut_ptr()
		}
	}

	impl Drop for Attr {
		fn drop(&mut self) {
			// SAFETY: initialized in `new`.
			unsafe { libc::posix_spawnattr_destroy(self.0.as_mut_ptr()) };
		}
	}
}

/// Block until `pid` exits and return its status, leaving it unreaped;
/// every stop and continue on the way goes to `tracker`
/// ([`ExtProc::poll_event`], zsh's `WUNTRACED`).
///
/// Stops and continues are waited for too (`WSTOPPED | WCONTINUED`; macOS
/// `waitid(WEXITED)` reports stops anyway, measured: `si_status` 17 after
/// `SIGSTOP`). With `WNOWAIT` such a report would repeat, so it is
/// consumed with a non-reaping `waitid(WSTOPPED | WCONTINUED | WNOHANG)`
/// (the event reported is the one consumed) and the wait goes on.
fn wait_exit(pid: i32, tracker: &Tracker) -> ExitStatus {
	loop {
		// SAFETY: siginfo_t is plain data, valid zeroed.
		let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
		// SAFETY: `info` is writable; WNOWAIT leaves the child waitable.
		let rc = unsafe {
			libc::waitid(
				libc::P_PID,
				pid as libc::id_t,
				&raw mut info,
				libc::WEXITED | libc::WSTOPPED | libc::WCONTINUED | libc::WNOWAIT,
			)
		};
		if rc == 0 {
			// SAFETY: waitid filled `info` for a CLD_* event.
			let status = unsafe { info.si_status() };
			match info.si_code {
				libc::CLD_EXITED => return ExitStatus::Exited(status),
				libc::CLD_KILLED | libc::CLD_DUMPED => return signaled(status),
				_ => {
					// SAFETY: as above; without WEXITED this never reaps.
					let mut seen: libc::siginfo_t = unsafe { std::mem::zeroed() };
					// SAFETY: `seen` is writable.
					let rc = unsafe {
						libc::waitid(
							libc::P_PID,
							pid as libc::id_t,
							&raw mut seen,
							libc::WSTOPPED | libc::WCONTINUED | libc::WNOHANG,
						)
					};
					// SAFETY: `seen` was zeroed and possibly filled by waitid.
					if rc != 0 || unsafe { seen.si_pid() } == 0 {
						// Nothing consumed: do not spin on a report that stays.
						thread::sleep(std::time::Duration::from_millis(10));
						continue;
					}
					// SAFETY: waitid filled `seen` for a CLD_* event.
					let sig = unsafe { seen.si_status() };
					match seen.si_code {
						libc::CLD_STOPPED => {
							let sig = u8::try_from(sig)
								.ok()
								.and_then(|n| Signal::from_number(n, Platform::current()))
								.unwrap_or(Signal::Stop);
							tracker.changed(ProcEvent::Stopped(sig));
						},
						libc::CLD_CONTINUED => tracker.changed(ProcEvent::Continued),
						_ => {},
					}
					continue;
				},
			}
		}
		if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
			// ECHILD: someone else reaped it (SIGCHLD set to SIG_IGN in the
			// host). The status is lost; report the conventional failure.
			return ExitStatus::Exited(127);
		}
	}
}

/// A pidfd of child `pid` (close-on-exec; readable once it exited); `None`
/// where the kernel has none (before 5.3) or refuses it. The child is
/// unreaped, so no failure means it is gone: each leaves it to a waiter.
#[cfg(target_os = "linux")]
fn pidfd_open(pid: i32) -> Option<OwnedFd> {
	match crate::sys::proc::pidfd_open(pid, None) {
		Ok(pi_builtins::proc_sys::Pidfd::Open(fd)) => Some(fd),
		_ => None,
	}
}

/// The exit status of `pid` if it has exited, leaving it unreaped (Linux
/// `waitid(WEXITED)` reports exits only).
#[cfg(target_os = "linux")]
fn exit_now(pid: i32) -> Option<ExitStatus> {
	// SAFETY: siginfo_t is plain data, valid zeroed.
	let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
	// SAFETY: `info` is writable; WNOWAIT leaves the child waitable.
	let rc = unsafe {
		libc::waitid(
			libc::P_PID,
			pid as libc::id_t,
			&raw mut info,
			libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
		)
	};
	if rc != 0 {
		// ECHILD: someone else reaped it (as in `wait_exit`). EINTR: the
		// pidfd stays readable, the next park returns at once.
		return (io::Error::last_os_error().kind() != io::ErrorKind::Interrupted)
			.then_some(ExitStatus::Exited(127));
	}
	// SAFETY: waitid filled `info`, or left it zeroed (no exit yet: pid 0).
	if unsafe { info.si_pid() } == 0 {
		return None;
	}
	// SAFETY: as above, for a CLD_* exit.
	let status = unsafe { info.si_status() };
	Some(match info.si_code {
		libc::CLD_KILLED | libc::CLD_DUMPED => signaled(status),
		_ => ExitStatus::Exited(status),
	})
}

fn signaled(n: i32) -> ExitStatus {
	u8::try_from(n)
		.ok()
		.and_then(|n| Signal::from_number(n, Platform::current()))
		.map_or(ExitStatus::SignaledRaw(n), ExitStatus::Signaled)
}

/// Reap `pid`, which has exited (or is about to: SIGKILL was sent).
fn reap(pid: i32) {
	let mut st = 0;
	// SAFETY: `st` is writable; `pid` is our unreaped child.
	while unsafe { libc::waitpid(pid, &raw mut st, 0) } < 0
		&& io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
	{}
}

/// A spawned external. Its process is never reaped while this exists, so
/// signals to its scope cannot reach a recycled pid or group.
struct UnixProc {
	pid:      i32,
	scope:    Scope,
	tracker:  Arc<Tracker>,
	shared:   Arc<Shared>,
	/// [`crate::bash::Lineage::detached`], or [`ExtProc::release`]d: dropping
	/// it while it runs releases the process instead of escalating TERM →
	/// KILL.
	detached: bool,
	/// The child's pumps and the shared input feeds it holds (kept open
	/// while this lives), driven by `poll_wait`.
	pumps:    Pumps,
	/// [`super::Exits::Park`]: the pidfd a [`Parker`](crate::sys::Parker) waits
	/// on, while no waiter thread watches the process.
	#[cfg(target_os = "linux")]
	pidfd:    Option<OwnedFd>,
	/// The first poll registers the pidfd directly; later polls may have
	/// been woken by its readiness and check the exit status.
	#[cfg(target_os = "linux")]
	awaited:  bool,
}

#[cfg(target_os = "linux")]
impl UnixProc {
	/// Parked: record the exit if the process has exited (unreaped); whether
	/// the exit is known.
	fn exited_now(&self) -> bool {
		if self.tracker.lock().has_exited() {
			return true;
		}
		let Some(status) = exit_now(self.pid) else {
			return false;
		};
		crate::sys::park::exits::forget(self.pid);
		// The `ExtProc` is alive: nothing to reap yet.
		let _ = self.tracker.exited(status);
		true
	}

	/// Parked and still running: have the next park wake `waker` at the
	/// exit, or hand the process to a waiter thread when no parker waits.
	fn await_exit(&mut self, waker: &std::task::Waker) {
		let Some(fd) = self.pidfd.as_ref().map(AsRawFd::as_raw_fd) else {
			return;
		};
		self.awaited = true;
		if !crate::sys::park::exits::await_exit(self.pid, fd, waker) {
			self.unpark();
		}
	}

	/// Hand the process to a waiter thread (it reaps when abandoned); wait
	/// here when no thread can be started.
	fn unpark(&mut self) {
		crate::sys::park::exits::forget(self.pid);
		if self.pidfd.take().is_some()
			&& watch(self.pid, Arc::clone(&self.tracker), Arc::clone(&self.shared)).is_err()
		{
			let status = wait_exit(self.pid, &self.tracker);
			if self.tracker.exited(status) {
				self.shared.state.reap(self.pid);
			}
		}
	}
}

impl ExtProc for UnixProc {
	fn pid(&self) -> u32 {
		self.pid as u32
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		#[cfg(target_os = "linux")]
		if self.pidfd.is_some() && !(self.awaited && self.exited_now()) {
			self.await_exit(cx.waker());
		}
		self.pumps.poll_exit(cx, &self.tracker)
	}

	fn poll_event(&mut self, cx: &mut Context<'_>) -> Poll<ProcEvent> {
		#[cfg(target_os = "linux")]
		if self.pidfd.is_some() && !(self.awaited && self.exited_now()) {
			self.await_exit(cx.waker());
		}
		self.pumps.poll_event(cx, &self.tracker)
	}

	fn pgid(&self) -> Option<u32> {
		match self.scope {
			Scope::Group(id) | Scope::Session(id) => u32::try_from(id).ok(),
			Scope::Process { .. } => None,
		}
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		self.tracker.lock().signalled(sig);
		self.scope.signal(sig)
	}

	fn stop(&mut self) -> io::Result<()> {
		self.scope.signal(Signal::Stop)
	}

	fn cont(&mut self) -> io::Result<()> {
		self.scope.signal(Signal::Cont)
	}

	/// Drop then releases it as a detached one ([`Self::detached`]). Its
	/// scope stays recorded: [`kill_leftovers`] (which only the test kit
	/// calls) still reaches it; nothing else ends it.
	fn release(&mut self) {
		self.detached = true;
	}
}

impl Drop for UnixProc {
	fn drop(&mut self) {
		// The pumps (and the feeds, giving back what no child read) stop when
		// the fields drop, after this.
		#[cfg(target_os = "linux")]
		if self.pidfd.is_some() {
			// Parked: no waiter knows the exit yet.
			self.exited_now();
			crate::sys::park::exits::forget(self.pid);
		}
		let grace = self.shared.config.grace;
		let mut life = self.tracker.lock();
		if self.detached {
			let exited = life.release();
			drop(life);
			if exited {
				self.shared.state.reap(self.pid);
				return;
			}
			// Running on; parked: a waiter observes the exit and reaps.
			#[cfg(target_os = "linux")]
			self.unpark();
			return;
		}
		let now = Instant::now();
		match life.abandon(now, grace) {
			Abandon::Exited => {
				drop(life);
				self.shared.state.reap(self.pid);
			},
			Abandon::Orphaned { term, sweep_at } => {
				// Unreaped (a zombie), so the scope is still ours.
				if term {
					let _ = self.scope.signal(Signal::Term);
				}
				let _ = self.scope.signal(Signal::Cont);
				drop(life);
				self.shared.state.reap(self.pid);
				let journal = Journal::open(&self.shared.state, self.scope, false, now);
				escalate_at(&self.tracker, self.scope, sweep_at, journal);
			},
			Abandon::Escalate { term, kill_at } => {
				// Under the lock: the waiter cannot record the exit and reap
				// in between, so the scope is still ours.
				if term {
					let _ = self.scope.signal(Signal::Term);
				}
				// A stopped (paused) group acts on TERM only once continued.
				let _ = self.scope.signal(Signal::Cont);
				drop(life);
				let journal = Journal::open(&self.shared.state, self.scope, true, now);
				escalate_at(&self.tracker, self.scope, kill_at, journal);
				// Parked: a waiter observes the exit and reaps.
				#[cfg(target_os = "linux")]
				self.unpark();
			},
		}
	}
}

/// [`escalate`] on a thread of its own; at once when no thread can be
/// started (KILL now rather than never).
fn escalate_at(tracker: &Arc<Tracker>, scope: Scope, kill_at: Instant, journal: Journal) {
	let waiter = Arc::clone(tracker);
	let fallback = journal.clone();
	let started = crate::sys::thread::spawn_helper(
		thread::Builder::new()
			.name("obash-kill".into())
			.stack_size(SMALL_STACK),
		move || escalate(&waiter, scope, kill_at, &journal),
	);
	if started.is_err() {
		let now = Instant::now();
		tracker.lock().schedule_kill(now);
		escalate(tracker, scope, now, &fallback);
	}
}

/// After `kill_at`: KILL the scope if its leader is still running (under the
/// lock, so it is unreaped), then every straggler left in a group or session
/// (identity-pinned). `journal` records each step.
fn escalate(tracker: &Tracker, scope: Scope, kill_at: Instant, journal: &Journal) {
	let now = Instant::now();
	if kill_at > now {
		thread::sleep(kill_at - now);
	}
	{
		let mut life = tracker.lock();
		let kill = life.take_kill(Instant::now().max(kill_at));
		journal.fire(scope, kill, kill_at);
		if kill {
			let _ = scope.signal(Signal::Kill);
		}
	}
	journal.swept(&scope.sweep());
}

/// The processes left in the recorded scopes, and whether the scan read
/// every process ([`proc::scan`]): one it could not read may be a leftover.
fn leftover_procs(shared: &Shared) -> (Vec<(Scope, ProcInfo)>, io::Result<()>) {
	// Keep process-only scopes unreaped until their identities have been
	// read: otherwise a recycled pid could appear to be our external.
	let mut groups = shared.state.groups.lock();
	let me = std::process::id() as i32;
	let (table, complete) = proc::scan();
	// A scope whose members were not read stays while `alive` says so.
	groups
		.list
		.retain(|s| table.iter().any(|p| s.contains(p)) || s.alive());
	groups.next_sweep = groups.list.len() + SWEEP;
	let left = table
		.into_iter()
		.filter(|p| p.pid != me && p.state != ProcState::Zombie)
		.filter_map(|p| groups.list.iter().find(|g| g.contains(&p)).map(|g| (*g, p)))
		.collect();
	(left, complete)
}

fn leftover((s, p): &(Scope, ProcInfo)) -> Leftover {
	Leftover { pid: p.pid as u32, group: s.id() as u32, name: p.name.clone() }
}

/// The leftovers; an error when the scan could not read every process,
/// since an unread one may be left over.
pub(super) fn leftovers(shared: &Shared) -> io::Result<Vec<Leftover>> {
	let (left, complete) = leftover_procs(shared);
	complete?;
	Ok(left.iter().map(leftover).collect())
}

/// Sends KILL to the leftovers the scan read, then reports whether it read
/// and signalled every process: one that cannot be signalled does not keep
/// the rest from being killed.
pub(super) fn kill_leftovers(shared: &Shared) -> io::Result<Vec<Leftover>> {
	let (left, complete) = leftover_procs(shared);
	let mut killed = Vec::new();
	let mut signalled = Ok(());
	for entry in left {
		match proc::signal_pinned(&entry.1, Signal::Kill) {
			Ok(true) => killed.push(leftover(&entry)),
			Ok(false) => {},
			Err(error) => signalled = signalled.and(Err(error)),
		}
	}
	complete.and(signalled).map(|()| killed)
}

#[cfg(test)]
mod tests;
#[cfg(target_os = "linux")]
mod vfork;
