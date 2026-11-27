//! The Linux spawn path's child: a `clone(CLONE_VM | CLONE_VFORK)` child
//! that sets the program up and execs it while the calling thread waits.
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
//! The caller blocks every signal across the clone, glibc's internal ones
//! included, so none can run a host handler in the child; where the block
//! is refused, it fails the spawn with that error and does not clone. The
//! child, in order: sets every signal's disposition (ignored if the program
//! starts with it ignored, else the default), leads a new session or process
//! group, hands a foreground job's terminal to its group, sets the umask,
//! changes to the working directory, installs the fds and closes the closed
//! ones, empties its signal mask, sets its OOM adjustment to 1000 (best
//! effort; before the limits, so a low open-files limit cannot refuse it),
//! sets the resource limits and execs. A failed step, a refused disposition
//! or mask change included, stores its errno for the caller and exits with
//! status 127; the caller reaps it and fails the spawn with that error. A
//! caller that cannot restore its own mask after the clone kills and reaps
//! the program and fails the spawn with that error (`spawn`).
//!
//! This file builds on its own, with `std` and `libc` only: an integration
//! test (`tests/vfork_child.rs`) includes it to run the clone under an
//! allocator that test controls.

use std::{
	cell::Cell,
	ffi::{c_char, c_int, c_long, c_void},
	io,
	sync::atomic::{AtomicI32, Ordering},
};

/// Bytes of a child's stack above its guard page. The child's frames take
/// a few hundred bytes; glibc gives its `posix_spawn` child 32 KiB.
const STACK: usize = 64 << 10;

/// The highest signal number (the kernel's 64-signal sets).
const SIGMAX: c_int = 64;

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
pub(super) struct Stack {
	base: *mut c_void,
	len:  usize,
}

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
				std::ptr::null_mut(),
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

thread_local! {
	/// The calling thread's child stack. A clone suspends its thread until
	/// the child execs or exits, so the thread's children use it one at a
	/// time.
	static STACKS: Cell<Option<Stack>> = const { Cell::new(None) };
}

/// Run `f` with the calling thread's child stack, mapped on its first use.
/// That first use of the thread-local slot may allocate; it comes here,
/// before `f`.
pub(super) fn with_stack<R>(f: impl FnOnce(&Stack) -> io::Result<R>) -> io::Result<R> {
	let stack = match STACKS.take() {
		Some(stack) => stack,
		None => Stack::new()?,
	};
	let result = f(&stack);
	STACKS.set(Some(stack));
	result
}

/// Start a child that sets up and execs `child`, on `stack`; its pid once it
/// exec'd. When a step fails, the child is reaped and the spawn fails with
/// that step's error (`ENOENT`, `EACCES`, `ENOEXEC`, `E2BIG` from the exec;
/// `EPERM` from a refused `setpgid`, …), a disposition or mask change that a
/// syscall filter refuses included. Neither the caller nor the child
/// allocates or takes a lock.
///
/// Where the calling thread cannot block every signal, the spawn fails with
/// that error and does not clone. Where it cannot restore its mask after the
/// clone, the program, which exec'd, is killed and reaped and the spawn
/// fails with that error; where the kill is refused, the spawn returns the
/// program's pid, so that nothing is left without an owner. A failed clone
/// or step decides the error before a failed restore.
///
/// # Safety
///
/// The pointers of `child` are valid C strings and NULL-terminated arrays of
/// them for the call.
pub(super) unsafe fn spawn(child: &Child<'_>, stack: &Stack) -> io::Result<c_int> {
	let arg = ChildArg { child, errno: AtomicI32::new(0) };
	let all = !0u64;
	let mut old = 0u64;
	// SAFETY: both sets are valid for the call.
	if unsafe { sigprocmask(libc::SIG_BLOCK, &raw const all, &raw mut old) } != 0 {
		return Err(io::Error::last_os_error());
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
	let failed = (pid < 0).then(io::Error::last_os_error);
	// SAFETY: restores the mask saved above.
	let restored = unsafe { sigprocmask(libc::SIG_SETMASK, &raw const old, std::ptr::null_mut()) };
	let unrestored = (restored != 0).then(io::Error::last_os_error);
	if let Some(err) = failed {
		return Err(err);
	}
	let errno = arg.errno.load(Ordering::Relaxed);
	if errno != 0 {
		reap(pid);
		return Err(io::Error::from_raw_os_error(errno));
	}
	if let Some(err) = unrestored {
		// The program runs: the spawn fails only once it ended.
		// SAFETY: a signal to our unreaped child.
		let killed = unsafe { libc::kill(pid, libc::SIGKILL) } == 0;
		if killed {
			reap(pid);
			return Err(err);
		}
	}
	Ok(pid)
}

/// Reap `pid`, a child that exited or was sent `SIGKILL`.
fn reap(pid: c_int) {
	loop {
		// SAFETY: no status wanted; the pid is our unreaped child.
		let rc = unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
		if rc >= 0 || errno_now() != libc::EINTR {
			return;
		}
	}
}

/// The child: set up and exec; on a failure report its errno and exit 127.
extern "C" fn entry(arg: *mut c_void) -> c_int {
	// SAFETY: `arg` is the `ChildArg` of `spawn`, alive until the clone
	// returns.
	let arg = unsafe { &*arg.cast::<ChildArg<'_>>() };
	// SAFETY: this is the vfork child of `spawn`, which blocked every signal;
	// its caller vouches for the pointers.
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
