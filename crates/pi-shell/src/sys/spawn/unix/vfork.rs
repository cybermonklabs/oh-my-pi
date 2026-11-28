//! The Linux spawn path's child: a `clone(CLONE_VM | CLONE_VFORK)` child
//! that sets the program up and execs it while the thread that cloned it
//! waits.
//!
//! The child shares the host's memory, so the clone copies none of it (a
//! `fork` copies the page tables of the whole host, in time growing with the
//! host's size), and its write to `/proc/self/oom_score_adj` changes its own
//! value alone: the kernel updates every other process sharing the writer's
//! memory, except when the writer is a vfork child (`__set_oom_adj` in
//! `fs/proc/base.c`). Sharing the host's memory, its thread-local storage
//! and every lock in them, the child makes only system calls on data
//! prepared before the clone: no allocation, no lock, no formatting and
//! nothing that can panic. It calls `libc` functions that are plain
//! system-call wrappers, and makes through `libc::syscall` the calls whose
//! `libc` wrappers are cancellation points, refuse glibc's internal signals
//! or can take a lock (musl's `setrlimit`).
//!
//! The clone runs on a launcher: a thread each spawning thread starts for
//! its spawns ([`prepare`]) and hands every spawn to, so the spawning
//! thread's own signal mask never changes, and the spawns of two threads
//! never wait for each other. The launcher blocks every signal across the
//! clone, glibc's internal ones included, so none can run a host handler in
//! the child, and unblocks them after; where the block is refused, it fails
//! the spawn with that error and does not clone. The child, in order: sets
//! every signal's disposition (ignored if the program starts with it
//! ignored, else the default), leads a new session or process group, hands
//! a foreground job's terminal to its group, sets the umask, changes to the
//! working directory, installs the fds and closes the closed ones, empties
//! its signal mask, sets its OOM adjustment to 1000 (best effort; before the
//! limits, so a low open-files limit cannot refuse it), sets the resource
//! limits and execs. A failed step, a refused disposition or mask change
//! included, stores its errno for the launcher and exits with status 127;
//! the launcher reaps it and fails the spawn with that error. A launcher
//! that cannot unblock its signals after the clone kills and reaps the
//! program, fails the spawn with that error and ends: it starts no child
//! with its signals left blocked, and the thread's next spawn starts another
//! launcher. Where it cannot confirm that a program it was to end has ended
//! (a refused kill or wait), the spawn fails saying so, and the launcher
//! keeps the program until it reaps it ([`spawn`]).
//!
//! The child inherits from the launcher what a child inherits from the
//! thread that clones it (seccomp filters, CPU affinity, scheduling
//! priority, capabilities): the launcher has what its spawning thread had
//! when it started the launcher. Between spawns the launcher blocks the
//! host's signals, so the host's handlers run on the host's threads.
//!
//! This file builds on its own, with `std` and `libc` only: an integration
//! test (`tests/vfork_child.rs`) includes it to run the clone under an
//! allocator that test controls.

use std::{
	cell::{Cell, UnsafeCell},
	ffi::{c_char, c_int, c_long, c_void},
	io, ptr,
	sync::{
		Arc,
		atomic::{AtomicI32, AtomicU32, Ordering},
	},
	thread,
	time::Duration,
};

/// Bytes of a child's stack above its guard page. The child's frames take
/// a few hundred bytes; glibc gives its `posix_spawn` child 32 KiB.
const STACK: usize = 64 << 10;

/// Bytes of a launcher thread's own stack: it waits, clones, signals and
/// reaps.
const LAUNCHER_STACK: usize = 64 << 10;

/// The highest signal number (the kernel's 64-signal sets).
const SIGMAX: c_int = 64;

/// The signals the libcs keep for themselves: glibc 32 and 33, musl 32 to
/// 34.
const LIBC_SIGNALS: std::ops::RangeInclusive<c_int> = 32..=34;

/// Every signal: the set a launcher blocks across its clone. A static, so a
/// syscall filter can tell this block from the libc's own.
pub(super) static ALL_SIGNALS: u64 = !0;

/// A resource id of `setrlimit` (the spawner's `rlimit::Resource`).
#[cfg(target_env = "gnu")]
pub(super) type Resource = libc::__rlimit_resource_t;
/// A resource id of `setrlimit` (the spawner's `rlimit::Resource`).
#[cfg(not(target_env = "gnu"))]
pub(super) type Resource = c_int;

/// What the child does before it execs: C strings and NULL-terminated
/// pointer arrays the caller keeps alive, and plain data.
pub(super) struct Child<'a> {
	/// The program to exec.
	pub(super) path:    *const c_char,
	/// The program's arguments, NULL-terminated.
	pub(super) argv:    *const *const c_char,
	/// The program's environment, NULL-terminated.
	pub(super) envp:    *const *const c_char,
	/// The working directory.
	pub(super) cwd:     *const c_char,
	/// Lead a new session (`setsid`).
	pub(super) session: bool,
	/// `setpgid(0, pgid)`: `0` leads a new group.
	pub(super) group:   Option<c_int>,
	/// A foreground job's terminal: the child makes its process group the
	/// terminal's foreground group.
	pub(super) tty:     Option<c_int>,
	pub(super) umask:   libc::mode_t,
	/// `(target, source)`, installed in this order. A target equal to its
	/// source stays, without close-on-exec (as glibc's
	/// `posix_spawn_file_actions_adddup2`).
	pub(super) fds:     &'a [(c_int, c_int)],
	/// Targets closed once the fds are installed.
	pub(super) closed:  &'a [c_int],
	/// The signals the program starts with ignored, bit `n - 1` for signal
	/// `n`; every other signal starts at its default.
	pub(super) ignored: u64,
	pub(super) limits:  &'a [(Resource, libc::rlimit)],
}

/// The clone's argument: the child's data and its report, the errno of the
/// step that failed.
struct ChildArg<'a> {
	child: &'a Child<'a>,
	errno: AtomicI32,
}

/// A child's stack: an anonymous mapping whose lowest page is a guard.
struct Stack {
	base: *mut c_void,
	len:  usize,
}

// SAFETY: a mapping its owner, a launcher's thread, alone uses.
unsafe impl Send for Stack {}

impl Stack {
	fn new() -> io::Result<Self> {
		// SAFETY: sysconf takes no pointers.
		let page = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })
			.ok()
			.filter(|&page| page > 0)
			.unwrap_or(4096);
		let len = STACK + page;
		// SAFETY: a new private anonymous mapping; the result is checked.
		let base = unsafe {
			libc::mmap(
				ptr::null_mut(),
				len,
				libc::PROT_READ | libc::PROT_WRITE,
				libc::MAP_PRIVATE | libc::MAP_ANONYMOUS | libc::MAP_STACK,
				-1,
				0,
			)
		};
		if base == libc::MAP_FAILED {
			return Err(io::Error::last_os_error());
		}
		// Unmapped on drop from here on.
		let stack = Self { base, len };
		// SAFETY: the lowest page of the mapping above.
		if unsafe { libc::mprotect(base, page, libc::PROT_NONE) } != 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(stack)
	}

	/// Where the child's stack starts: stacks grow down on every
	/// architecture Linux runs this on.
	const fn top(&self) -> *mut c_void {
		self.base.wrapping_byte_add(self.len)
	}
}

impl Drop for Stack {
	fn drop(&mut self) {
		// SAFETY: the mapping `new` made, which no child uses any more: each
		// ran to its exec or exit before its clone returned.
		unsafe { libc::munmap(self.base, self.len) };
	}
}

/// A spawn's outcome, as its launcher reports it.
#[derive(Clone, Copy)]
enum Outcome {
	/// The program runs: its pid.
	Started(c_int),
	/// The spawn failed with this errno and left no child.
	Failed(c_int),
	/// The spawn failed with `errno` after it started program `pid`, whose
	/// end the launcher could not confirm (a refused kill or wait): the
	/// launcher keeps it until it reaps it.
	Unended { errno: c_int, pid: c_int },
}

/// A spawn handed to a launcher, and its outcome.
#[derive(Clone, Copy)]
struct Job {
	/// The child to start: valid while its poster waits for the outcome.
	child:   *const Child<'static>,
	outcome: Outcome,
	/// The launcher ended with this spawn: it starts no other.
	retired: bool,
}

impl Job {
	const NONE: Self = Self { child: ptr::null(), outcome: Outcome::Failed(0), retired: false };
}

// SAFETY: `child` is dereferenced only on the launcher's thread, while the
// thread that posted the job waits for its outcome and keeps the child alive.
unsafe impl Send for Job {}

// A launcher's states: starting, waiting for a spawn, given one, done with
// it, told to end.
const STARTING: u32 = 0;
const IDLE: u32 = 1;
const POSTED: u32 = 2;
const DONE: u32 = 3;
const EXIT: u32 = 4;

/// What a spawning thread and its launcher share: the launcher's state and
/// the spawn in hand.
struct Slot {
	state: AtomicU32,
	job:   UnsafeCell<Job>,
}

// SAFETY: one side at a time touches `job`: the spawning thread while the
// state is `IDLE` or `DONE`, the launcher while it is `POSTED`; the release
// store of each state and the acquire load that sees it hand it over. The
// child pointer is read only while its poster waits.
unsafe impl Sync for Slot {}

/// A spawning thread's launcher: the thread that clones its children.
struct Launcher {
	slot: Arc<Slot>,
	/// The process that started it: a `fork` copies the slot, not the
	/// thread.
	pid:  u32,
}

impl Launcher {
	/// Start a launcher on a thread of its own, which has what the calling
	/// thread has. Returns once that thread runs: its start allocates, and
	/// nothing after it does.
	fn start() -> io::Result<Self> {
		let stack = Stack::new()?;
		let slot =
			Arc::new(Slot { state: AtomicU32::new(STARTING), job: UnsafeCell::new(Job::NONE) });
		let theirs = Arc::clone(&slot);
		thread::Builder::new()
			.name("omp-spawn".into())
			.stack_size(LAUNCHER_STACK)
			.spawn(move || serve(&theirs, &stack))?;
		wait_for(&slot.state, |state| state != STARTING);
		Ok(Self { slot, pid: std::process::id() })
	}

	/// Whether this process started it: a `fork`'s copy has no thread.
	fn ours(&self) -> bool {
		self.pid == std::process::id()
	}

	/// Hand `child` to the launcher and wait for the spawn: its result, and
	/// whether the launcher ended with it.
	///
	/// # Safety
	///
	/// As [`spawn`].
	unsafe fn run(&self, child: &Child<'_>) -> (io::Result<c_int>, bool) {
		let slot = &*self.slot;
		// SAFETY: `IDLE`: the launcher reads the job only once it is posted.
		unsafe { *slot.job.get() = Job { child: ptr::from_ref(child).cast(), ..Job::NONE } };
		slot.state.store(POSTED, Ordering::Release);
		futex_wake(&slot.state);
		wait_for(&slot.state, |state| state == DONE);
		// SAFETY: `DONE`: the launcher no longer touches the job.
		let job = unsafe { *slot.job.get() };
		slot.state.store(IDLE, Ordering::Relaxed);
		let result = match job.outcome {
			Outcome::Started(pid) => Ok(pid),
			Outcome::Failed(errno) => Err(io::Error::from_raw_os_error(errno)),
			Outcome::Unended { errno, pid } => Err(unended(errno, pid)),
		};
		(result, job.retired)
	}
}

impl Drop for Launcher {
	fn drop(&mut self) {
		if self.ours() {
			self.slot.state.store(EXIT, Ordering::Release);
			futex_wake(&self.slot.state);
		}
	}
}

thread_local! {
	/// The calling thread's launcher, from its first spawn on.
	static LAUNCHER: Cell<Option<Launcher>> = const { Cell::new(None) };
}

/// The calling thread's launcher, taken out of its slot; a new one where it
/// has none, its launcher ended, or its launcher is a `fork`'s copy.
fn launcher() -> io::Result<Launcher> {
	match LAUNCHER
		.try_with(Cell::take)
		.ok()
		.flatten()
		.filter(Launcher::ours)
	{
		Some(launcher) => Ok(launcher),
		None => Launcher::start(),
	}
}

/// Put `launcher` back as the calling thread's (dropped, and so ended, while
/// the thread's slot is being destroyed).
fn keep(launcher: Launcher) {
	let _ = LAUNCHER.try_with(|slot| slot.set(Some(launcher)));
}

/// Start the calling thread's launcher where it has none. That allocates;
/// the thread's spawns after it do not, until a spawn ends its launcher.
/// [`spawn`] starts one too.
pub(super) fn prepare() -> io::Result<()> {
	keep(launcher()?);
	Ok(())
}

/// Start a child that sets up and execs `child`, on the calling thread's
/// launcher ([`prepare`]); its pid once it exec'd. When a step fails, the
/// child is reaped and the spawn fails with that step's error (`ENOENT`,
/// `EACCES`, `ENOEXEC`, `E2BIG` from the exec; `EPERM` from a refused
/// `setpgid`, …), a disposition or mask change that a syscall filter refuses
/// included. The calling thread's signal mask does not change.
///
/// Where the launcher cannot block its signals, the spawn fails with that
/// error and does not clone. Where it cannot unblock them after the clone,
/// the program, which exec'd, is killed and reaped, the spawn fails with
/// that error, and the launcher ends. Where the kill or the reap is refused,
/// the spawn fails with an error that names the program, and the launcher
/// keeps it: it waits for the program to end and reaps it, then ends. A
/// failed clone or step decides the error before a failed unblock.
///
/// Past [`prepare`], neither the calling thread, the launcher nor the child
/// allocates or takes a lock.
///
/// # Safety
///
/// The pointers of `child` are valid C strings and NULL-terminated arrays of
/// them for the call.
pub(super) unsafe fn spawn(child: &Child<'_>) -> io::Result<c_int> {
	let launcher = launcher()?;
	// SAFETY: the caller vouches for `child`.
	let (result, retired) = unsafe { launcher.run(child) };
	if !retired {
		keep(launcher);
	}
	result
}

/// The error of a spawn that failed with `errno` after it started program
/// `pid`, which its launcher could not end: the launcher reaps it once it
/// exits.
fn unended(errno: c_int, pid: c_int) -> io::Error {
	let error = io::Error::from_raw_os_error(errno);
	io::Error::new(
		error.kind(),
		format!("{error}; its program (pid {pid}) could not be ended and is reaped once it exits"),
	)
}

/// A launcher's thread: run each spawn posted to `slot`, cloning on `stack`,
/// until told to end or a spawn left it unable to start another.
fn serve(slot: &Slot, stack: &Stack) {
	// Between spawns only the libcs' own signals reach this thread (glibc's
	// `setuid` waits for every thread to take one). Best effort.
	let host = (1..=SIGMAX)
		.filter(|n| !LIBC_SIGNALS.contains(n))
		.fold(0u64, |set, n| set | (1 << (n - 1)));
	// SAFETY: a valid set; no old set wanted.
	unsafe { sigprocmask(libc::SIG_SETMASK, &raw const host, ptr::null_mut()) };
	slot.state.store(IDLE, Ordering::Release);
	futex_wake(&slot.state);
	while wait_for(&slot.state, |state| state == POSTED || state == EXIT) == POSTED {
		let job = slot.job.get();
		// SAFETY: `POSTED`: the poster waits for `DONE`, its child's pointers
		// valid until then, and touches the job only then.
		let launched = unsafe { launch(&*(*job).child, stack) };
		// SAFETY: as above, before the `DONE` below.
		unsafe {
			(*job).outcome = launched.outcome;
			(*job).retired = launched.retire;
		}
		slot.state.store(DONE, Ordering::Release);
		futex_wake(&slot.state);
		if let Outcome::Unended { pid, .. } = launched.outcome {
			own(pid);
		}
		if launched.retire {
			return;
		}
	}
}

/// What one spawn left its launcher: the spawn's outcome, and whether the
/// launcher ends (its signals stay blocked, or it keeps an unended child).
struct Launched {
	outcome: Outcome,
	retire:  bool,
}

/// One spawn of `child` on `stack`, on a launcher's thread: block every
/// signal, clone, unblock what the block added.
///
/// # Safety
///
/// Only on a launcher's thread, with `child` as [`spawn`] takes it and
/// `stack` that thread's own.
unsafe fn launch(child: &Child<'_>, stack: &Stack) -> Launched {
	let arg = ChildArg { child, errno: AtomicI32::new(0) };
	let mut old = 0u64;
	// SAFETY: both sets are valid for the call.
	if unsafe { sigprocmask(libc::SIG_BLOCK, &raw const ALL_SIGNALS, &raw mut old) } != 0 {
		return Launched { outcome: Outcome::Failed(errno_now()), retire: false };
	}
	// SAFETY: the child runs on `stack`, which nothing else uses (the clone
	// returns only once the child exec'd or exited), and reads `arg`, which
	// outlives it for the same reason; the caller vouches for `child`.
	let pid = unsafe {
		libc::clone(
			entry,
			stack.top(),
			libc::CLONE_VM | libc::CLONE_VFORK | libc::SIGCHLD,
			(&raw const arg).cast_mut().cast(),
		)
	};
	// Read before anything else can change errno; a child that ran may have
	// written the thread's errno too.
	let cloned = if pid < 0 { Err(errno_now()) } else { Ok(pid) };
	// Unblock what the block added: the mask as it was, which nothing else
	// changes on this thread.
	let added = ALL_SIGNALS & !old;
	// SAFETY: a valid set; no old set wanted.
	let unblocked = added == 0
		|| unsafe { sigprocmask(libc::SIG_UNBLOCK, &raw const added, ptr::null_mut()) } == 0;
	let unblock_errno = if unblocked { 0 } else { errno_now() };
	let retire = !unblocked;
	let pid = match cloned {
		Ok(pid) => pid,
		Err(errno) => return Launched { outcome: Outcome::Failed(errno), retire },
	};
	let step = arg.errno.load(Ordering::Relaxed);
	if step == 0 && unblocked {
		return Launched { outcome: Outcome::Started(pid), retire: false };
	}
	let errno = if step == 0 { unblock_errno } else { step };
	// A child whose step failed has exited; a program that runs is killed.
	// SAFETY: a signal to our unreaped child.
	let ended = (step != 0 || unsafe { libc::kill(pid, libc::SIGKILL) } == 0) && reap(pid).is_ok();
	if ended {
		Launched { outcome: Outcome::Failed(errno), retire }
	} else {
		Launched { outcome: Outcome::Unended { errno, pid }, retire: true }
	}
}

/// Keep program `pid`, which a spawn left unended, until it is reaped: wait
/// for it, again after a pause where a wait fails.
fn own(pid: c_int) {
	let mut pause = Duration::from_millis(1);
	while reap(pid).is_err() {
		thread::sleep(pause);
		pause = (pause * 2).min(Duration::from_secs(1));
	}
}

/// Reap `pid`, our child that exited or was sent `SIGKILL`: done once its
/// status is taken, or once it is no child of ours (`ECHILD`: another
/// waiter took it). A wait a signal interrupts waits again; the errno of a
/// wait that failed otherwise, the child then still unreaped.
pub(super) fn reap(pid: c_int) -> Result<(), c_int> {
	loop {
		// SAFETY: no status wanted.
		if unsafe { libc::waitpid(pid, ptr::null_mut(), 0) } >= 0 {
			return Ok(());
		}
		match errno_now() {
			libc::EINTR => {},
			libc::ECHILD => return Ok(()),
			errno => return Err(errno),
		}
	}
}

/// The child: set up and exec; on a failure report its errno and exit 127.
extern "C" fn entry(arg: *mut c_void) -> c_int {
	// SAFETY: `arg` is the `ChildArg` of `launch`, alive until the clone
	// returns.
	let arg = unsafe { &*arg.cast::<ChildArg<'_>>() };
	// SAFETY: this is the vfork child of `launch`, which blocked every
	// signal; its caller vouches for the pointers.
	let errno = unsafe { run(arg.child) };
	arg.errno.store(errno, Ordering::Relaxed);
	// SAFETY: ends the child without running any code of the host's.
	unsafe { libc::_exit(127) }
}

/// The child's steps (see the module docs); the errno of the step that
/// failed (`execve` returns only when it failed).
///
/// # Safety
///
/// Only in a vfork child of a thread that blocked every signal.
unsafe fn run(child: &Child<'_>) -> c_int {
	// SAFETY: system calls on data the caller prepared, none allocating or
	// locking; the C strings and arrays are NUL- and NULL-terminated.
	unsafe {
		for sig in 1..=SIGMAX {
			if sig != libc::SIGKILL && sig != libc::SIGSTOP {
				let ignored = (child.ignored >> (sig - 1)) & 1 != 0;
				let handler = if ignored {
					libc::SIG_IGN
				} else {
					libc::SIG_DFL
				};
				if set_action(sig, handler) != 0 {
					return errno_now();
				}
			}
		}
		if child.session && libc::setsid() < 0 {
			return errno_now();
		}
		if let Some(pgid) = child.group
			&& libc::setpgid(0, pgid) < 0
		{
			return errno_now();
		}
		// Allowed although the group may be in the background: `SIGTTOU` is
		// blocked.
		if let Some(tty) = child.tty {
			libc::tcsetpgrp(tty, libc::getpgrp());
		}
		libc::umask(child.umask);
		if libc::chdir(child.cwd) != 0 {
			return errno_now();
		}
		for &(target, source) in child.fds {
			if target == source {
				let flags = libc::fcntl(target, libc::F_GETFD);
				if flags < 0 || libc::fcntl(target, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
					return errno_now();
				}
			} else if libc::dup3(source, target, 0) < 0 {
				return errno_now();
			}
		}
		for &fd in child.closed {
			libc::syscall(libc::SYS_close, fd);
		}
		// Only now may pending signals arrive: they act as on the program.
		let empty = 0u64;
		if sigprocmask(libc::SIG_SETMASK, &raw const empty, std::ptr::null_mut()) != 0 {
			return errno_now();
		}
		// Before the limits: a low `RLIMIT_NOFILE` (`ulimit -n 3`) would
		// refuse the open.
		prefer_oom_kill();
		for (resource, limit) in child.limits {
			if set_limit(*resource, limit) != 0 {
				return errno_now();
			}
		}
		libc::execve(child.path, child.argv, child.envp);
		errno_now()
	}
}

/// Set `/proc/self/oom_score_adj` to 1000, the kernel's maximum, so the
/// kernel kills this process before the host when it picks a process to
/// kill for lack of memory. Best effort: a refused write leaves the value
/// as it was. Makes only system calls.
///
/// # Safety
///
/// Only in a child before it execs that is a vfork child or has memory of
/// its own (a fork child): a process sharing the host's memory otherwise
/// sets the host's value too.
pub(super) unsafe fn prefer_oom_kill() {
	const VALUE: &[u8] = b"1000";
	// SAFETY: a static C path and buffer; the fd is checked and closed.
	unsafe {
		let fd = libc::syscall(
			libc::SYS_openat,
			libc::AT_FDCWD,
			c"/proc/self/oom_score_adj".as_ptr(),
			libc::O_WRONLY | libc::O_CLOEXEC,
		);
		if fd >= 0 {
			libc::syscall(libc::SYS_write, fd, VALUE.as_ptr(), VALUE.len());
			libc::syscall(libc::SYS_close, fd);
		}
	}
}

/// `rt_sigaction(sig, handler)` with no flags and an empty mask; glibc's
/// `sigaction` refuses its internal signals. 0, or -1 with errno set.
unsafe fn set_action(sig: c_int, handler: libc::sighandler_t) -> c_long {
	// The kernel's `struct sigaction`: the handler, the flags, `sa_restorer`
	// and the mask (x86-64, 64-bit Arm). Only the handler is set, so an
	// architecture without `sa_restorer` reads the same action from it.
	let action: [usize; 4] = [handler, 0, 0, 0];
	// SAFETY: a valid action, no old action wanted, the kernel's set size.
	unsafe {
		libc::syscall(
			libc::SYS_rt_sigaction,
			sig,
			action.as_ptr(),
			std::ptr::null_mut::<usize>(),
			size_of::<u64>(),
		)
	}
}

/// `rt_sigprocmask` on the kernel's 64-signal set; glibc's `sigprocmask`
/// leaves its internal signals out. 0, or -1 with errno set.
unsafe fn sigprocmask(how: c_int, set: *const u64, old: *mut u64) -> c_long {
	// SAFETY: the caller passes sets valid for the call (or null `old`).
	unsafe { libc::syscall(libc::SYS_rt_sigprocmask, how, set, old, size_of::<u64>()) }
}

// `prlimit64` reads the kernel's `struct rlimit64`, two 64-bit values:
// `libc::rlimit` on the 64-bit targets the child runs on.
const _: () = assert!(size_of::<libc::rlimit>() == 2 * size_of::<u64>());

/// `prlimit64(0, resource, limit, NULL)`: musl's `setrlimit` answers the
/// call's `ENOSYS` (a syscall filter's) with `__synccall`, which takes its
/// threads' lock. 0, or -1 with errno set.
unsafe fn set_limit(resource: Resource, limit: &libc::rlimit) -> c_long {
	// This process.
	let pid: libc::pid_t = 0;
	// SAFETY: a valid limit, no old limit wanted.
	unsafe {
		libc::syscall(
			libc::SYS_prlimit64,
			pid,
			resource,
			std::ptr::from_ref(limit),
			std::ptr::null_mut::<libc::rlimit>(),
		)
	}
}

/// The calling thread's errno.
fn errno_now() -> c_int {
	// SAFETY: libc's errno location of the calling thread, always valid.
	unsafe { *libc::__errno_location() }
}

/// Sleep while `word` holds `value`, until woken; at once where it holds
/// another.
fn futex_wait(word: &AtomicU32, value: u32) {
	// SAFETY: a private futex on a valid word, without a timeout.
	unsafe {
		libc::syscall(
			libc::SYS_futex,
			word.as_ptr(),
			libc::FUTEX_WAIT | libc::FUTEX_PRIVATE_FLAG,
			value,
			ptr::null::<libc::timespec>(),
		)
	};
}

/// Wake the thread that waits on `word`.
fn futex_wake(word: &AtomicU32) {
	// SAFETY: a private futex on a valid word.
	unsafe {
		libc::syscall(libc::SYS_futex, word.as_ptr(), libc::FUTEX_WAKE | libc::FUTEX_PRIVATE_FLAG, 1)
	};
}

/// Wait until `word` holds a value `done` takes; that value.
fn wait_for(word: &AtomicU32, done: impl Fn(u32) -> bool) -> u32 {
	loop {
		let now = word.load(Ordering::Acquire);
		if done(now) {
			return now;
		}
		futex_wait(word, now);
	}
}
