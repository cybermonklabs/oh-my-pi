//! Cross-platform process tree management.

use std::{
	collections::{HashMap, HashSet},
	io,
	time::Duration,
};

use anyhow::Result;
/// Current state of a process reference.
///
/// Defined in `pi-builtins` alongside the process-table snapshots its process
/// builtins read, and re-exported here so this module — and `pi-natives`
/// through it — keeps one status type for both concerns.
pub use pi_builtins::ProcessStatus;

use crate::cancel::CancelToken;

#[cfg(target_os = "linux")]
mod platform {
	use std::{
		collections::HashSet,
		fs, io,
		os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd},
		sync::Arc,
	};

	use pi_builtins::proc_sys as sys;

	use super::{ProcessStatus, Walk, unread};

	/// Stable Linux process reference: a pidfd, or where the system provides
	/// none, the process's start time, rechecked before each use.
	#[derive(Clone)]
	pub struct Process {
		pid:        i32,
		/// `None` where `pidfd_open` is unavailable ([`pidfd_unavailable`]):
		/// the process is then pinned by `start_time` alone, as
		/// `sys::proc::signal_pinned` does there.
		pidfd:      Option<Arc<OwnedFd>>,
		start_time: u64,
	}

	/// Whether `error` from `pidfd_open` says the system provides no pidfd,
	/// rather than anything about the process: `ENOSYS` (kernels before
	/// 5.3) or `EPERM` (a seccomp or LSM filter; `pidfd_open` checks no
	/// permission on its target).
	fn pidfd_unavailable(error: &io::Error) -> bool {
		matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EPERM))
	}

	#[cfg(test)]
	thread_local! {
		/// Pin this thread's processes as where `pidfd_open` is unavailable.
		pub(crate) static NO_PIDFD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
	}

	/// `pidfd_open(pid)`.
	fn pidfd_open(pid: i32) -> io::Result<OwnedFd> {
		#[cfg(test)]
		if NO_PIDFD.get() {
			return Err(io::Error::from_raw_os_error(libc::ENOSYS));
		}
		// SAFETY: pidfd_open takes scalar arguments and returns a new owned
		// fd.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
		if fd < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a successful pidfd_open returned a uniquely owned
		// descriptor that fits an `i32`.
		Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			Self::open(pid).ok().flatten()
		}

		/// The process `pid`, pinned: `Ok(None)` when it is gone, or no
		/// signal of ours reaches it; `Err` when it could not be read for a
		/// reason that proves nothing (no descriptor left). Where the system
		/// provides no pidfd it is pinned by its start time instead.
		pub fn open(pid: i32) -> io::Result<Option<Self>> {
			Ok(Self::pin(pid)?.map(|(process, _)| process))
		}

		/// [`Process::open`], with the parent the kernel records for it.
		fn pin(pid: i32) -> io::Result<Option<(Self, i32)>> {
			if pid <= 0 {
				return Ok(None);
			}
			let pidfd = match pidfd_open(pid) {
				Ok(fd) => Some(Arc::new(fd)),
				Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(None),
				Err(error) if pidfd_unavailable(&error) => None,
				Err(error) => return Err(error),
			};
			let Some(info) = crate::sys::proc::read(pid)? else {
				return Ok(None);
			};
			// A zombie is pinned, as `pidfd_open` pins one: it reads as exited
			// ([`Process::status`]) and takes no signal.
			Ok(Some((Self { pid, pidfd, start_time: info.start }, info.ppid)))
		}

		/// Whether the process `pid` names is still this one, by its start
		/// time: `None` when that cannot be read for a reason that proves
		/// nothing (no descriptor left).
		fn same_start(&self) -> Option<bool> {
			match crate::sys::proc::read(self.pid) {
				Ok(Some(now)) => Some(
					now.start == self.start_time && now.state != crate::sys::proc::ProcState::Zombie,
				),
				Ok(None) => Some(false),
				Err(_) => None,
			}
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		/// The kernel's start mark of this process, read when it was pinned:
		/// its start time in clock ticks since boot (field 22 of
		/// `/proc/<pid>/stat`). With the boot it is counted from
		/// ([`start_mark`](super::Process::start_mark)), it names this
		/// process alone; no wall-clock step moves it.
		pub const fn start_ticks(&self) -> u64 {
			self.start_time
		}

		/// The live children, and whether every candidate was read: `Err`
		/// names what could not be, while this process still runs (a child it
		/// had is now another's).
		pub fn children(&self) -> Walk<Self> {
			let mut walk = Walk::default();
			// The pidfd pins the process: while it runs, its pid is its own,
			// and no read is needed to know it.
			if self.status() != ProcessStatus::Running {
				return walk;
			}

			// `/proc/{pid}/task/{tid}/children` is per-task: a child fork()ed from
			// a worker thread appears under that thread's `tid`, not the tgid.
			// Walk every task subdir and union the lists, then re-validate
			// parentage.
			let task_dir = format!("/proc/{}/task", self.pid);
			let mut seen: HashSet<i32> = HashSet::new();
			let mut children_file_available = false;
			match fs::read_dir(&task_dir) {
				Ok(entries) => {
					for entry in entries {
						let entry = match entry {
							Ok(entry) => entry,
							Err(error) => {
								self.note(&mut walk, &error, "list the threads of");
								continue;
							},
						};
						let name = entry.file_name();
						let Some(tid) = name.to_str().filter(|tid| tid.parse::<i32>().is_ok()) else {
							continue;
						};
						match fs::read_to_string(format!("{task_dir}/{tid}/children")) {
							Ok(content) => {
								// The file is readable -> this kernel has
								// CONFIG_PROC_CHILDREN.
								children_file_available = true;
								for part in content.split_whitespace() {
									if let Ok(child_pid) = part.parse::<i32>() {
										self.push_validated_child(child_pid, &mut seen, &mut walk);
									}
								}
							},
							// The thread exited since the listing.
							Err(error)
								if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => {},
							Err(error) => self.note(&mut walk, &error, "read the children of"),
						}
					}
				},
				Err(error) => self.note(&mut walk, &error, "list the threads of"),
			}

			// Some Kata / microVM guest kernels are built without
			// CONFIG_PROC_CHILDREN, so no `.../children` file exists and the
			// walk above finds nothing — which would silently turn descendant
			// signaling (cancellation cleanup) into a no-op inside such
			// containers. Fall back to scanning `/proc` and grouping
			// by parent pid, the same primitive the macOS path uses. Only taken
			// when no `children` file was readable, so kernels that support it
			// keep the cheap per-task fast path.
			if !children_file_available
				&& walk.complete.is_ok()
				&& self.status() == ProcessStatus::Running
			{
				match fs::read_dir("/proc") {
					Ok(entries) => {
						for entry in entries {
							let entry = match entry {
								Ok(entry) => entry,
								Err(error) => {
									self.note(
										&mut walk,
										&error,
										"scan the process table for the children of",
									);
									continue;
								},
							};
							if let Some(child_pid) =
								entry.file_name().to_str().and_then(|n| n.parse().ok())
							{
								self.push_validated_child(child_pid, &mut seen, &mut walk);
							}
						}
					},
					Err(error) => {
						self.note(&mut walk, &error, "scan the process table for the children of");
					},
				}
			}
			walk
		}

		/// Records `error`, a failure to read what this process's children
		/// are, unless this process has exited meanwhile.
		fn note(&self, walk: &mut Walk<Self>, error: &io::Error, what: &str) {
			if self.status() == ProcessStatus::Running {
				walk.fail(unread(error, format_args!("cannot {what} process {}", self.pid)));
			}
		}

		/// Validate a candidate child pid — dedup, still running, and currently
		/// parented to `self` — then push it onto `walk`. Shared by the
		/// `/proc/<pid>/task/<tid>/children` fast path and the `/proc`-scan
		/// fallback for kernels without `CONFIG_PROC_CHILDREN`. A candidate
		/// that cannot be pinned or read makes the walk incomplete.
		fn push_validated_child(
			&self,
			child_pid: i32,
			seen: &mut HashSet<i32>,
			walk: &mut Walk<Self>,
		) {
			if child_pid == self.pid || !seen.insert(child_pid) {
				return;
			}
			match Self::pin(child_pid) {
				Ok(Some((child, parent))) => {
					if parent == self.pid && child.status() == ProcessStatus::Running {
						walk.processes.push(child);
					}
				},
				Ok(None) => {},
				Err(error) => walk.fail(unread(
					&error,
					format_args!(
						"cannot read process {child_pid}, a possible child of process {}",
						self.pid
					),
				)),
			}
		}

		pub fn parent_pid(&self) -> Option<i32> {
			if self.status() == ProcessStatus::Running {
				sys::parent_pid(self.pid)
			} else {
				None
			}
		}

		pub fn args(&self) -> Vec<String> {
			if !self.live_identity() {
				return Vec::new();
			}

			let Some(args) = sys::cmdline(self.pid) else {
				return Vec::new();
			};
			// Re-validate after the read: PID reuse between identity check and
			// read would otherwise leak an impostor's command line to callers.
			if !self.live_identity() {
				return Vec::new();
			}
			args
		}

		/// Send `signal` to this process: through its pidfd, which can never
		/// reach a recycled pid; without one, by its pid once its start time
		/// says it is still this process (the window between the check and
		/// the signal is `sys::proc::signal_pinned`'s on the same systems).
		pub fn kill(&self, signal: i32) -> bool {
			match &self.pidfd {
				Some(pidfd) => sys::pidfd_send_signal(pidfd.as_fd(), signal),
				None => {
					self.same_start() == Some(true)
						// SAFETY: plain syscall without pointer arguments.
						&& unsafe { libc::kill(self.pid, signal) } == 0
				},
			}
		}

		pub fn group_id(&self) -> Option<i32> {
			if self.status() != ProcessStatus::Running {
				return None;
			}

			// SAFETY: `self.pid` names the process currently referenced by
			// `self.pidfd` unless it exits concurrently. If it exits, `getpgid`
			// reports failure rather than dereferencing caller-owned memory.
			let pgid = unsafe { libc::getpgid(self.pid) };
			if pgid > 0 { Some(pgid) } else { None }
		}

		pub fn status(&self) -> ProcessStatus {
			let Some(pidfd) = &self.pidfd else {
				// A start time that cannot be read proves nothing: running, as
				// for a poll error below.
				return match self.same_start() {
					Some(false) => ProcessStatus::Exited,
					Some(true) | None => ProcessStatus::Running,
				};
			};
			loop {
				let mut pollfd =
					libc::pollfd { fd: pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
				// SAFETY: `pollfd` points to one initialized `pollfd` element, and
				// the pidfd remains open for the duration of the call. Timeout
				// zero makes this a non-blocking readiness probe.
				let ready = unsafe { libc::poll(&raw mut pollfd, 1, 0) };
				if ready < 0 {
					// Retry on EINTR; for any other transient poll error treat the
					// pidfd as still running. The pidfd is still owned and the
					// kernel has not reported the process gone — a spurious
					// `Exited` here makes every downstream signal/kill fall
					// through silently.
					if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
						continue;
					}
					return ProcessStatus::Running;
				}
				if ready == 0 {
					return ProcessStatus::Running;
				}
				if (pollfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL))
					!= 0
				{
					return ProcessStatus::Exited;
				}
				return ProcessStatus::Running;
			}
		}

		/// Resolves once the process exits: its pidfd becomes readable then;
		/// without a pidfd, its start time is rechecked every 20 ms.
		pub async fn exited(&self) -> std::io::Result<()> {
			let Some(pidfd) = &self.pidfd else {
				while self.status() == ProcessStatus::Running {
					tokio::time::sleep(std::time::Duration::from_millis(20)).await;
				}
				return Ok(());
			};
			let pidfd = tokio::io::unix::AsyncFd::with_interest(
				pidfd.try_clone()?,
				tokio::io::Interest::READABLE,
			)?;
			let _ready = pidfd.readable().await?;
			Ok(())
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle. The walk
		/// goes on past a process it cannot read, and reports the first.
		pub fn descendants(&self) -> Walk<Self> {
			let mut walk = Walk::default();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			self.descendants_into(&mut walk, &mut visited);
			walk
		}

		fn descendants_into(&self, walk: &mut Walk<Self>, visited: &mut HashSet<i32>) {
			let children = self.children();
			if let Err(error) = children.complete {
				walk.fail(error);
			}
			for child in children.processes {
				if visited.insert(child.pid) {
					child.descendants_into(walk, visited);
					walk.processes.push(child);
				}
			}
		}

		fn live_identity(&self) -> bool {
			self.status() == ProcessStatus::Running
				&& sys::start_time(self.pid) == Some(self.start_time)
		}
	}

	/// Find processes whose `/proc/{pid}/exe` symlink resolves to exactly
	/// `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		sys::pids()
			.filter(|pid| {
				fs::read_link(format!("/proc/{pid}/exe"))
					.is_ok_and(|resolved| resolved.as_os_str() == target)
			})
			.filter_map(Process::from_pid)
			.collect()
	}
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		io, ptr,
	};

	use pi_builtins::proc_sys as sys;

	use super::{ProcessStatus, Walk, unread};

	/// macOS does not expose pidfds; identity is pinned via the kernel-reported
	/// process start time so a recycled PID does not silently impersonate the
	/// original target.
	#[derive(Clone)]
	pub struct Process {
		pid:          i32,
		start_tvsec:  u64,
		start_tvusec: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			Self::open(pid).ok().flatten()
		}

		/// The process `pid`, pinned by its start time: `Ok(None)` when it is
		/// gone, or no signal of ours reaches it; `Err` when it could not be
		/// read for a reason that proves nothing.
		pub fn open(pid: i32) -> io::Result<Option<Self>> {
			if pid <= 0 {
				return Ok(None);
			}
			let Some(info) = crate::sys::proc::read(pid)? else {
				return Ok(None);
			};
			// `ProcInfo::start` is µs since the epoch, `tvsec * 1e6 + tvusec`.
			Ok(Some(Self {
				pid,
				start_tvsec: info.start / 1_000_000,
				start_tvusec: info.start % 1_000_000,
			}))
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		/// The kernel's start mark of this process, read when it was pinned:
		/// µs since the epoch (`pbi_start_tvsec`, `pbi_start_tvusec`), which the
		/// kernel recorded at the start and no later wall-clock step moves.
		pub const fn start_ticks(&self) -> u64 {
			self
				.start_tvsec
				.saturating_mul(1_000_000)
				.saturating_add(self.start_tvusec)
		}

		/// The live children, and whether every candidate was read.
		pub fn children(&self) -> Walk<Self> {
			if self.live_bsdinfo().is_none() {
				return Walk::default();
			}
			// `proc_listchildpids` (the obvious choice) is broken on recent macOS
			// kernels when queried for the *calling* process — it returns one byte
			// of padding regardless of how many children the process actually
			// has, so a process can never list its own descendants. Confirmed
			// on darwin 25.4 from C, Rust, and Bun callers via
			// `proc_listchildpids(getpid(), …)`, while `ps -P` and `pgrep -P`
			// still see the same children. Walk the whole pid table via
			// `proc_listallpids` and filter on `pbi_ppid` instead; this is the
			// same approach we already use for `find_by_path` and that the
			// Windows implementation uses via Toolhelp snapshots.
			let (tree, complete) = build_process_tree();
			let mut walk = Walk { processes: Vec::new(), complete };
			Self::children_from_tree(self.pid, &tree, &mut walk);
			walk
		}

		pub fn parent_pid(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_ppid).ok().filter(|ppid| *ppid > 0)
		}

		pub fn args(&self) -> Vec<String> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}
			sys::args(self.pid)
		}

		pub fn kill(&self, signal: i32) -> bool {
			// Re-validate identity right before signaling. There is no atomic
			// "kill iff start_time matches" primitive on macOS, so a vanishingly
			// small window remains between this check and the syscall — but
			// matching against the recorded `(pid, start_tvsec, start_tvusec)`
			// triple eliminates the PID-reuse race in every practical case.
			if self.live_bsdinfo().is_none() {
				return false;
			}
			// SAFETY: `kill` takes integer identifiers by value and does not
			// access caller-owned memory.
			unsafe { libc::kill(self.pid, signal) == 0 }
		}

		pub fn group_id(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_pgid).ok().filter(|pgid| *pgid > 0)
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle. The walk
		/// goes on past a process it cannot read, and reports the first.
		pub fn descendants(&self) -> Walk<Self> {
			// One process-table snapshot per walk — building it inside the
			// recursion would re-scan every pid for every visited node,
			// producing an `O(N · D)` kernel call pattern. Mirrors the Windows
			// implementation.
			let (tree, complete) = build_process_tree();
			let mut walk = Walk { processes: Vec::new(), complete };
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			Self::collect_descendants_from_tree(self.pid, &tree, &mut visited, &mut walk);
			walk
		}

		/// The pinned process `child_pid`, or a failure to pin it recorded in
		/// `walk`.
		fn pin_child(child_pid: i32, walk: &mut Walk<Self>) -> Option<Self> {
			match Self::open(child_pid) {
				Ok(child) => child,
				Err(error) => {
					walk.fail(unread(&error, format_args!("cannot read process {child_pid}")));
					None
				},
			}
		}

		fn children_from_tree(parent: i32, tree: &HashMap<i32, Vec<i32>>, walk: &mut Walk<Self>) {
			for &child_pid in tree.get(&parent).into_iter().flatten() {
				if let Some(child) = Self::pin_child(child_pid, walk) {
					walk.processes.push(child);
				}
			}
		}

		fn collect_descendants_from_tree(
			parent: i32,
			tree: &HashMap<i32, Vec<i32>>,
			visited: &mut HashSet<i32>,
			walk: &mut Walk<Self>,
		) {
			let Some(child_pids) = tree.get(&parent) else {
				return;
			};
			for &child_pid in child_pids {
				if !visited.insert(child_pid) {
					continue;
				}
				let Some(child) = Self::pin_child(child_pid, walk) else {
					continue;
				};
				// Post-order: grandchildren first, so leaf processes get signalled
				// before their parents during tree termination.
				Self::collect_descendants_from_tree(child_pid, tree, visited, walk);
				walk.processes.push(child);
			}
		}

		pub fn status(&self) -> ProcessStatus {
			if self.live_bsdinfo().is_some() {
				ProcessStatus::Running
			} else {
				ProcessStatus::Exited
			}
		}

		/// Resolves once the process exits, through a kqueue `NOTE_EXIT`
		/// filter.
		pub async fn exited(&self) -> std::io::Result<()> {
			use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

			// SAFETY: `kqueue` takes no arguments; a negative result is an error.
			let kq = unsafe { libc::kqueue() };
			if kq < 0 {
				return Err(std::io::Error::last_os_error());
			}
			// SAFETY: `kq` is a fresh descriptor nothing else owns.
			let kq = unsafe { OwnedFd::from_raw_fd(kq) };
			// Scoped so the raw record (its `udata` is a `*mut c_void`) is gone
			// before the await below; holding it would make this future `!Send`.
			let registered = {
				let change = libc::kevent {
					ident:  self.pid as libc::uintptr_t,
					filter: libc::EVFILT_PROC,
					flags:  libc::EV_ADD | libc::EV_ONESHOT,
					fflags: libc::NOTE_EXIT,
					data:   0,
					udata:  ptr::null_mut(),
				};
				// SAFETY: `change` is one initialized change record; with no event
				// buffer the call only registers it and the null timeout is unused.
				unsafe {
					libc::kevent(kq.as_raw_fd(), &raw const change, 1, ptr::null_mut(), 0, ptr::null())
				}
			};
			if registered < 0 {
				let err = std::io::Error::last_os_error();
				// No such process: it is already gone.
				return (err.raw_os_error() == Some(libc::ESRCH)).ok_or(err);
			}
			// The pid may have been reused before the filter was registered, in
			// which case it watches another process; confirm identity after.
			if self.status() != ProcessStatus::Running {
				return Ok(());
			}
			let kq = tokio::io::unix::AsyncFd::with_interest(kq, tokio::io::Interest::READABLE)?;
			let _ready = kq.readable().await?;
			Ok(())
		}

		/// Returns the current `proc_bsdinfo` only if it still describes the same
		/// process this reference was opened on — i.e. the start time has not
		/// changed.
		fn live_bsdinfo(&self) -> Option<libc::proc_bsdinfo> {
			let info = sys::bsdinfo(self.pid)?;
			if info.pbi_start_tvsec == self.start_tvsec && info.pbi_start_tvusec == self.start_tvusec {
				Some(info)
			} else {
				None
			}
		}
	}

	/// Build a `ppid -> [pids]` map from a one-shot scan of the process table
	/// ([`crate::sys::proc::scan`]), and whether the scan read every process
	/// that may be one of ours.
	///
	/// Used as the foundation of `Process::children` and `Process::descendants`
	/// on macOS where `proc_listchildpids` returns no children for self-queries.
	pub(super) fn build_process_tree() -> (HashMap<i32, Vec<i32>>, io::Result<()>) {
		let (table, complete) = crate::sys::proc::scan();
		let mut tree: HashMap<i32, Vec<i32>> = HashMap::with_capacity(table.len() / 2);
		for info in table {
			if info.ppid > 0 {
				tree.entry(info.ppid).or_default().push(info.pid);
			}
		}
		(tree, complete)
	}

	/// Find processes whose libproc-reported executable path equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let mut path = [0u8; sys::PATH_CAPACITY];
		sys::pids()
			.into_iter()
			.filter(|pid| *pid > 0 && sys::executable_path(*pid, &mut path) == Some(target.as_bytes()))
			.filter_map(Process::from_pid)
			.collect()
	}
}
#[cfg(target_os = "windows")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ffi::OsStr,
		os::windows::{ffi::OsStrExt, io::OwnedHandle},
		sync::Arc,
	};

	use pi_builtins::proc_sys as sys;
	use smallvec::SmallVec;

	use super::{ProcessStatus, Walk, unread};

	const PROCESS_REFERENCE_ACCESS: u32 =
		sys::PROCESS_TERMINATE | sys::PROCESS_QUERY_LIMITED_INFORMATION | sys::SYNCHRONIZE;
	/// `GetLastError` of an `OpenProcess` refused the access asked for.
	const ERROR_ACCESS_DENIED: i32 = 5;

	#[derive(Clone)]
	/// Stable Windows process reference backed by an owned process handle plus
	/// the kernel-reported creation time, which pins identity even if the PID is
	/// recycled while we hold the handle.
	pub struct Process {
		pid:           i32,
		handle:        Arc<OwnedHandle>,
		creation_time: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			Self::open(pid).ok().flatten()
		}

		/// The process `pid`, pinned by a handle and its creation time:
		/// `Ok(None)` when no process holds `pid` (`OpenProcess` gives
		/// `ERROR_INVALID_PARAMETER`), or when the open is refused the access
		/// a kill needs (`ERROR_ACCESS_DENIED`: no `TerminateProcess` of ours
		/// reaches it, as `EPERM` on Unix); `Err` for any other failure (no
		/// memory or handle left), which proves nothing.
		pub fn open(pid: i32) -> std::io::Result<Option<Self>> {
			let Ok(id) = u32::try_from(pid) else {
				return Ok(None);
			};
			if id == 0 {
				return Ok(None);
			}
			let handle = match sys::try_open_process(id, PROCESS_REFERENCE_ACCESS) {
				Ok(Some(handle)) => handle,
				Ok(None) => return Ok(None),
				Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED) => return Ok(None),
				Err(error) => return Err(error),
			};
			let creation_time = sys::process_times(&handle)
				.ok_or_else(std::io::Error::last_os_error)?
				.0;
			Ok(Some(Self { pid, handle: Arc::new(handle), creation_time }))
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		/// The kernel's start mark of this process: its creation time
		/// (`FILETIME`, 100 ns ticks since 1601), which the kernel recorded at
		/// the start and no later wall-clock step moves.
		pub const fn start_ticks(&self) -> u64 {
			self.creation_time
		}

		pub fn parent_pid(&self) -> Option<i32> {
			sys::parent_pid(&self.handle)
		}

		/// Read through the pinned handle, so it is always this process's
		/// command line even after the pid is reused.
		pub fn args(&self) -> Vec<String> {
			sys::command_line(&self.handle)
				.map_or_default(|command_line| sys::split_command_line(&command_line))
		}

		/// The children in one Toolhelp snapshot; the walk is incomplete when
		/// the snapshot could not be taken or read whole, or a child could not
		/// be opened ([`Process::open`]).
		pub fn children(&self) -> Walk<Self> {
			let (tree, complete) = build_process_tree();
			let mut walk = Walk { processes: Vec::new(), complete };
			walk.processes = self.children_from_tree(&tree, &mut walk);
			walk
		}

		/// Walk the entire descendant tree using a single Toolhelp snapshot.
		///
		/// `children()` recursing per-node would re-snapshot the whole process
		/// table for every visited descendant, making tree termination
		/// `O(N · D)` snapshots. One snapshot per termination wave is enough.
		pub fn descendants(&self) -> Walk<Self> {
			let (tree, complete) = build_process_tree();
			let mut walk = Walk { processes: Vec::new(), complete };
			let Ok(root) = u32::try_from(self.pid) else {
				return walk;
			};
			let mut visited: HashSet<u32> = HashSet::new();
			visited.insert(root);
			self.collect_descendants_from_tree(&tree, &mut visited, &mut walk);
			walk
		}

		/// The running process `child_pid`, when it really is a child of
		/// `self`. Windows never rewrites the parent id recorded for a process
		/// whose parent exited, so such an orphan is listed as a child of
		/// whichever process reuses that pid. A real child cannot have been
		/// created before its parent; an orphan older than `self` can. A
		/// candidate that cannot be opened makes `walk` incomplete.
		fn child(&self, child_pid: u32, walk: &mut Walk<Self>) -> Option<Self> {
			let child = match Self::open(i32::try_from(child_pid).ok()?) {
				Ok(child) => child?,
				Err(error) => {
					walk.fail(unread(
						&error,
						format_args!(
							"cannot open process {child_pid}, a possible child of process {}",
							self.pid
						),
					));
					return None;
				},
			};
			(child.creation_time >= self.creation_time && child.status() == ProcessStatus::Running)
				.then_some(child)
		}

		pub(super) fn children_from_tree(
			&self,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
			walk: &mut Walk<Self>,
		) -> Vec<Self> {
			let Ok(pid_u32) = u32::try_from(self.pid) else {
				return Vec::new();
			};
			tree
				.get(&pid_u32)
				.into_iter()
				.flatten()
				.filter_map(|&child_pid| self.child(child_pid, walk))
				.collect()
		}

		fn collect_descendants_from_tree(
			&self,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
			visited: &mut HashSet<u32>,
			walk: &mut Walk<Self>,
		) {
			let Some(children) = u32::try_from(self.pid).ok().and_then(|pid| tree.get(&pid)) else {
				return;
			};
			for &child_pid in children {
				if !visited.insert(child_pid) {
					continue;
				}
				let Some(child) = self.child(child_pid, walk) else {
					continue;
				};
				// Post-order: collect grandchildren first so leaves are signalled
				// before their parents during tree termination.
				child.collect_descendants_from_tree(tree, visited, walk);
				walk.processes.push(child);
			}
		}

		/// The handle pins the original kernel process object even after the
		/// pid is recycled, so this cannot hit a different process.
		pub fn kill(&self, _signal: i32) -> bool {
			sys::terminate(&self.handle)
		}

		pub const fn group_id() -> Option<i32> {
			None
		}

		pub fn status(&self) -> ProcessStatus {
			if sys::has_exited(&self.handle) {
				ProcessStatus::Exited
			} else {
				ProcessStatus::Running
			}
		}

		/// Resolves once the process exits, through a thread-pool wait on the
		/// process handle, so no thread is parked per waiter.
		pub async fn exited(&self) -> std::io::Result<()> {
			sys::exited(Arc::clone(&self.handle)).await
		}
	}

	/// Build a map of `parent_pid` -> [`child_pids`] for all processes, and
	/// whether the snapshot was taken and read whole.
	pub(super) fn build_process_tree() -> (HashMap<u32, SmallVec<[u32; 4]>>, std::io::Result<()>) {
		let mut tree: HashMap<u32, SmallVec<[u32; 4]>> = HashMap::new();
		let table = match sys::process_table() {
			Ok(table) => table,
			Err(error) => {
				return (tree, Err(unread(&error, format_args!("cannot list the processes"))));
			},
		};
		for entry in table {
			tree.entry(entry.ppid).or_default().push(entry.pid);
		}
		(tree, Ok(()))
	}

	/// Find processes whose `QueryFullProcessImageNameW` result equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let target: Vec<u16> = OsStr::new(target).encode_wide().collect();
		let mut path = vec![0u16; 32_768];
		sys::processes()
			.filter(|entry| {
				sys::open_process(entry.pid, sys::PROCESS_QUERY_LIMITED_INFORMATION)
					.is_some_and(|handle| sys::image_path(&handle, &mut path) == Some(&target[..]))
			})
			.filter_map(|entry| Process::from_pid(i32::try_from(entry.pid).ok()?))
			.collect()
	}
}

/// This boot's id (`/proc/sys/kernel/random/boot_id`), read once per
/// process: a read that fails (no descriptor left, a sandbox that hides
/// the file) is `None` and tried again at the next call; the first that
/// succeeds is kept, so no later failure can change a mark.
#[cfg(target_os = "linux")]
fn boot_id() -> Option<&'static str> {
	static BOOT_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
	if let Some(id) = BOOT_ID.get() {
		return Some(id);
	}
	let read = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
	let id = read.trim();
	if id.is_empty() {
		return None;
	}
	Some(BOOT_ID.get_or_init(|| id.to_owned()))
}

/// Stable process reference.
#[derive(Clone)]
pub struct Process {
	inner: platform::Process,
}

impl Process {
	/// Open a stable process reference from a PID: `None` when the process is
	/// gone, or cannot be pinned ([`Process::open`] tells the two apart).
	pub fn from_pid(pid: i32) -> Option<Self> {
		platform::Process::from_pid(pid).map(Self::from_inner)
	}

	/// Open a stable process reference from a PID: `Ok(None)` when the
	/// process is gone, or no signal of ours reaches it.
	///
	/// # Errors
	///
	/// When the process could not be read for a reason that proves nothing
	/// (no descriptor left; on Windows, an `OpenProcess` failure other than
	/// no such process or access denied). Where Linux provides no pidfd, the
	/// process is pinned by its start time instead.
	pub fn open(pid: i32) -> io::Result<Option<Self>> {
		Ok(platform::Process::open(pid)?.map(Self::from_inner))
	}

	/// Open stable process references whose executable path matches exactly.
	pub fn from_path(path: String) -> Vec<Self> {
		platform::find_by_path(&path)
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Operating-system process identifier for this process reference.
	#[must_use]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	/// The kernel's start mark of this process, read when it was pinned: on
	/// Linux the boot's id (`/proc/sys/kernel/random/boot_id`, read once per
	/// process: it cannot change while this process runs) and the start in
	/// clock ticks since that boot; on macOS and Windows the start time the
	/// kernel recorded. A pid recorded with this mark names this process
	/// alone: one that reused the pid has another. No clock is compared, so
	/// a step of the wall clock changes nothing. `None` when the boot id
	/// cannot be read (no descriptor left, a sandbox that hides it): no mark
	/// is known, which proves nothing about the process.
	#[must_use]
	pub fn start_mark(&self) -> Option<String> {
		#[cfg(target_os = "linux")]
		{
			boot_id().map(|boot| format!("{boot}:{}", self.inner.start_ticks()))
		}
		#[cfg(not(target_os = "linux"))]
		{
			Some(self.inner.start_ticks().to_string())
		}
	}

	/// Parent process id for this process, when available.
	#[must_use]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.parent_pid()
	}

	/// Launch arguments for this process.
	#[must_use]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	/// Send `signal` to this process only, through its pinned identity, so it
	/// never reaches a process that reused the pid after this one was reaped.
	/// On Windows the process is terminated whatever `signal` is.
	pub fn signal(&self, signal: i32) -> bool {
		self.inner.kill(signal)
	}

	/// Send `signal` to this process and its descendants, children first, and
	/// to its process group when it leads one; returns how many processes it
	/// signalled.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	///
	/// # Errors
	///
	/// When the walk could not read every process of the tree: everything it
	/// read is signalled first (and the group, which needs no read), but a
	/// descendant it could not read, outside the group, may not have been.
	pub fn kill_tree(&self, signal: Option<i32>) -> io::Result<u32> {
		self.signal_tree(signal.unwrap_or(KILL_SIGNAL))
	}

	/// Process group id for this process, when supported by the platform.
	#[cfg(target_os = "windows")]
	#[must_use]
	pub const fn group_id(&self) -> Option<i32> {
		platform::Process::group_id()
	}

	#[cfg(not(target_os = "windows"))]
	#[must_use]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id()
	}

	/// Direct children of this process as stable process references.
	///
	/// # Errors
	///
	/// When a candidate could not be read for a reason that proves nothing:
	/// a child may be missing from what was found.
	pub fn children(&self) -> io::Result<Vec<Self>> {
		let walk = self.inner.children();
		walk.complete?;
		Ok(walk.processes.into_iter().map(Self::from_inner).collect())
	}

	/// Current status of this process reference.
	#[must_use]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status()
	}

	/// Gracefully terminate this process and its descendants.
	///
	/// Sends `TERM_SIGNAL` to the optional process group, every live descendant,
	/// and the root, then optionally waits up to `graceful_ms` for the tree to
	/// exit before escalating to `KILL_SIGNAL`. Pass `graceful_ms < 0` to skip
	/// the wait entirely (the polite signal is still emitted). Returns `true`
	/// when the tree has exited by the end of the hard wave's wait window.
	///
	/// A wave whose walk could not read the whole tree also signals the
	/// process group the root leads, if any (it needs no read); and the call
	/// fails once the hard wave is sent if its walk was incomplete, since a
	/// descendant it could not read may still run.
	pub async fn terminate_tree(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		self
			.terminate_tree_impl(group, graceful_ms, timeout_ms, ct)
			.await
	}

	/// Wait until this process exits, optionally bounded by `timeout`.
	pub async fn wait_for_exit(&self, timeout: Option<Duration>, ct: CancelToken) -> Result<bool> {
		wait_for_exit(self, &[], timeout, ct).await
	}
}

impl Process {
	const fn from_inner(inner: platform::Process) -> Self {
		Self { inner }
	}

	/// Walk the live descendant tree from scratch. Cheap and idempotent — call
	/// it again before each signal wave so grandchildren spawned during a grace
	/// period are not missed.
	fn live_descendants(&self) -> Walk<Self> {
		let walk = self.inner.descendants();
		Walk {
			processes: walk.processes.into_iter().map(Self::from_inner).collect(),
			complete:  walk.complete,
		}
	}

	fn signal_tree(&self, signal: i32) -> io::Result<u32> {
		self.signal_tree_excluding(signal, &host_protected_pids())
	}

	/// The process group this process leads, which a signal reaches without
	/// reading the process table.
	fn own_group(&self) -> Option<i32> {
		self.group_id().filter(|&pgid| pgid == self.inner.pid())
	}

	/// Signal this process and its live descendants (children first), skipping
	/// any pid in `protected`.
	///
	/// `protected` shields the harness itself: a run-cancellation sweep must
	/// never hard-kill the host. On Windows the
	/// descendant tree is derived from raw `th32ParentProcessID` values that
	/// outlive their recorded parent, so a freshly spawned child whose recycled
	/// pid matches the harness's stale parent pid makes the harness enumerate
	/// as a false descendant; `TerminateProcess`-ing it drops the whole session
	/// with no cleanup and no `session_exit` record (#7452, related #4605).
	fn signal_tree_excluding(&self, signal: i32, protected: &HashSet<i32>) -> io::Result<u32> {
		let descendants = self.signalable_descendants(protected);
		let mut signaled = 0u32;
		// If self leads its own process group, also signal the group — this
		// catches grandchildren reparented to init when their immediate parent
		// died inside the descendant walk, and those the walk could not read.
		let group = self.own_group();
		if let Some(pgid) = group {
			let _ = kill_process_group(pgid, signal);
		}
		for child in &descendants.processes {
			if child.inner.kill(signal) {
				signaled += 1;
			}
		}
		if !protected.contains(&self.pid()) && self.inner.kill(signal) {
			signaled += 1;
		}
		descendants
			.complete
			.map(|()| signaled)
			.map_err(|error| partly_signalled(&error, signaled, group))
	}

	/// Live descendants with every protected subtree pruned, not just the exact
	/// protected pids.
	///
	/// The flattened descendant list can contain a protected node (the harness,
	/// on a Windows PID-reuse false-descendant) *together with* that node's real
	/// children, which were collected by recursing through it. Skipping only the
	/// exact protected pid would still terminate those unrelated worker/tool
	/// subprocesses, so drop every node whose recorded parent chain — within the
	/// enumerated set — passes through a protected pid (#7452 review).
	fn signalable_descendants(&self, protected: &HashSet<i32>) -> Walk<Self> {
		let mut walk = self.live_descendants();
		let parents: HashMap<i32, i32> = walk
			.processes
			.iter()
			.filter_map(|descendant| descendant.ppid().map(|parent| (descendant.pid(), parent)))
			.collect();
		walk
			.processes
			.retain(|descendant| !pid_in_protected_subtree(descendant.pid(), protected, &parents));
		walk
	}

	/// One signal wave: the group (`group`, or the one the root leads when
	/// the walk is incomplete), every live descendant, then the root. Returns
	/// the walk, for the wait.
	fn signal_wave(&self, signal: i32, group: Option<i32>, protected: &HashSet<i32>) -> Walk<Self> {
		if let Some(pgid) = group {
			let _ = kill_process_group(pgid, signal);
		}
		let descendants = self.signalable_descendants(protected);
		for child in &descendants.processes {
			let _ = child.inner.kill(signal);
		}
		if !protected.contains(&self.pid()) {
			let _ = self.inner.kill(signal);
		}
		if descendants.complete.is_err()
			&& group.is_none()
			&& let Some(pgid) = self.own_group()
		{
			let _ = kill_process_group(pgid, signal);
		}
		descendants
	}

	async fn terminate_tree_impl(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		if self.status() != ProcessStatus::Running {
			return Ok(true);
		}

		let process_group = if group { self.group_id() } else { None };
		let protected = host_protected_pids();

		// Polite wave: SIGTERM the group, every live descendant, then the root.
		let polite = self.signal_wave(TERM_SIGNAL, process_group, &protected);

		// Optional grace wait. A negative `graceful_ms` skips the wait entirely
		// (we still emit the polite signal so cleanup handlers can run before
		// KILL). An incomplete walk proves no exit: the hard wave follows.
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				self,
				&polite.processes,
				Some(Duration::from_millis(graceful_ms as u64)),
				ct.clone(),
			)
			.await?;
			if exited && polite.complete.is_ok() {
				return Ok(true);
			}
		}

		// Hard wave. Re-walk the tree so any grandchild spawned during the grace
		// period — or any process re-parented to the root — is signalled too.
		let hard = self.signal_wave(KILL_SIGNAL, process_group, &protected);
		let exited = wait_for_exit(
			self,
			&hard.processes,
			Some(Duration::from_millis(u64::from(timeout_ms))),
			ct,
		)
		.await?;
		match hard.complete {
			Ok(()) => Ok(exited),
			Err(error) => {
				let group = process_group.or_else(|| self.own_group());
				Err(
					partly_signalled(
						&error,
						u32::try_from(hard.processes.len()).unwrap_or(u32::MAX),
						group,
					)
					.into(),
				)
			},
		}
	}
}

/// A walk of a process tree: the processes found, and the first process it
/// could not read for a reason that proves nothing, after which a process of
/// the tree may be missing from what was found.
struct Walk<P> {
	processes: Vec<P>,
	complete:  io::Result<()>,
}

impl<P> Default for Walk<P> {
	fn default() -> Self {
		Self { processes: Vec::new(), complete: Ok(()) }
	}
}

impl<P> Walk<P> {
	/// Records `error` unless an earlier one was.
	fn fail(&mut self, error: io::Error) {
		if self.complete.is_ok() {
			self.complete = Err(error);
		}
	}
}

/// `error`, a failed read, as `WHAT: strerror`.
fn unread(error: &io::Error, what: std::fmt::Arguments<'_>) -> io::Error {
	io::Error::new(error.kind(), format!("{what}: {}", crate::bash::diag::strerror(error)))
}

/// `error`, which left a walk incomplete, once `signalled` processes of the
/// tree (and the process group `group`, if any) were signalled.
fn partly_signalled(error: &io::Error, signalled: u32, group: Option<i32>) -> io::Error {
	let group = group.map_or_else(String::new, |pgid| format!(" and process group {pgid}"));
	io::Error::new(
		error.kind(),
		format!(
			"{error}: signalled {signalled} processes of the tree{group}, but one the walk could not \
			 read may not have been"
		),
	)
}

/// The harness pid — the one process a run-cancellation sweep must never
/// signal.
///
/// On Unix the descendant walk is identity-pinned (pidfd / start-time), so the
/// host can never appear as a false descendant and this set is a harmless
/// no-op safety net. On Windows the descendant tree is derived from raw
/// `th32ParentProcessID` values that survive their recorded parent's death: a
/// freshly spawned child whose recycled pid matches the harness's stale parent
/// pid makes the harness enumerate as a false descendant, so cancelling a
/// timed-out bash run would `TerminateProcess` the host with no cleanup and no
/// `session_exit` record (#7452, related #4605).
///
/// Do not walk the host's numeric parent chain here. On Windows the host's
/// recorded parent pid can itself have been recycled onto the cancellation
/// target; treating that raw pid as protected would spare the hung command and
/// prune all of its descendants from cleanup.
fn host_protected_pids() -> HashSet<i32> {
	i32::try_from(std::process::id()).into_iter().collect()
}

/// True when `pid` is itself protected or descends — within the enumerated
/// `parents` map (pid -> recorded parent pid) — from a protected pid. Used to
/// prune a whole protected subtree from a cancellation sweep so a false
/// descendant of the harness cannot drag the harness's real children into the
/// kill set (#7452).
fn pid_in_protected_subtree(
	pid: i32,
	protected: &HashSet<i32>,
	parents: &HashMap<i32, i32>,
) -> bool {
	let mut current = pid;
	// Bound the walk against a corrupted or cyclic parent chain.
	for _ in 0..256 {
		if protected.contains(&current) {
			return true;
		}
		match parents.get(&current) {
			Some(&parent) if parent != current => current = parent,
			_ => return false,
		}
	}
	false
}

async fn wait_for_exit(
	root: &Process,
	descendants: &[Process],
	timeout: Option<Duration>,
	ct: CancelToken,
) -> Result<bool> {
	ct.heartbeat()?;
	if root.status() != ProcessStatus::Running
		&& descendants
			.iter()
			.all(|process| process.status() != ProcessStatus::Running)
	{
		return Ok(true);
	}

	// A lone process is awaited through the OS exit notification. Polling woke
	// every waiter 20 times a second, and IPC workers wait on their parent for
	// their whole life. Trees still poll: their membership changes.
	if descendants.is_empty()
		&& let Some(result) = wait_for_root_exit(root, timeout, &ct).await
	{
		return result;
	}

	let poll_interval = Duration::from_millis(50);
	let mut elapsed = Duration::ZERO;
	while timeout.is_none_or(|limit| elapsed < limit) {
		let sleep_for =
			timeout.map_or(poll_interval, |limit| limit.saturating_sub(elapsed).min(poll_interval));
		if sleep_for.is_zero() {
			break;
		}
		ct.heartbeat()?;
		tokio::time::sleep(sleep_for).await;
		elapsed += sleep_for;

		if root.status() != ProcessStatus::Running
			&& descendants
				.iter()
				.all(|process| process.status() != ProcessStatus::Running)
		{
			return Ok(true);
		}
	}

	Ok(false)
}

/// Waits for `root` to exit through the platform's exit notification:
/// `Ok(true)` once it exited, `Ok(false)` when `timeout` elapsed first.
/// `None` when no notification could be set up, so the caller polls instead.
async fn wait_for_root_exit(
	root: &Process,
	timeout: Option<Duration>,
	ct: &CancelToken,
) -> Option<Result<bool>> {
	let exited = root.inner.exited();
	let bounded = async {
		match timeout {
			Some(limit) => tokio::time::timeout(limit, exited).await.ok(),
			None => Some(exited.await),
		}
	};
	tokio::select! {
		outcome = bounded => match outcome {
			None => Some(Ok(false)),
			Some(Ok(())) => Some(Ok(true)),
			Some(Err(_)) => None,
		},
		reason = ct.wait() => Some(Err(anyhow::Error::msg(format!("Aborted: {reason:?}")))),
	}
}

/// Send `signal` to the process group `pgid`.
/// Returns false when process groups are unsupported on the platform.
#[allow(clippy::missing_const_for_fn, reason = "Dispatches to platform-specific implementation")]
#[must_use]
pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
	// Defense in depth: refuse to deliver a signal to the harness's own
	// process group. Doing so terminates the harness along with the targets.
	// Callers only ever hold pgids of processes they spawned (never the
	// harness pgid); this catches any future caller that gets that wrong.
	if pgid <= 0 || is_self_process_group(pgid) {
		return false;
	}
	platform_kill_process_group(pgid, signal)
}

#[cfg(unix)]
fn platform_kill_process_group(pgid: i32, signal: i32) -> bool {
	// SAFETY: `kill` takes integer identifiers by value and does not access
	// caller-owned memory. A negative PID is the POSIX process-group form.
	unsafe { libc::kill(-pgid, signal) == 0 }
}

/// Process groups are not exposed on Windows.
#[cfg(not(unix))]
const fn platform_kill_process_group(_pgid: i32, _signal: i32) -> bool {
	false
}

#[cfg(unix)]
fn is_self_process_group(pgid: i32) -> bool {
	// SAFETY: `getpgid(0)` queries the calling process's pgid and does not
	// access caller-owned memory. A return value <= 0 is treated as "unknown",
	// which fails open so the actual signal call decides.
	let self_pgid = unsafe { libc::getpgid(0) };
	self_pgid > 0 && self_pgid == pgid
}

#[cfg(not(unix))]
const fn is_self_process_group(_pgid: i32) -> bool {
	false
}

/// POSIX `SIGTERM` / Windows polite termination sentinel.
pub const TERM_SIGNAL: i32 = 15;

/// POSIX `SIGKILL` / Windows hard-termination sentinel.
pub const KILL_SIGNAL: i32 = 9;

/// A collection of process groups and process trees scheduled for
/// termination together.
///
/// Built incrementally from job records or PTY metadata, then signalled
/// in escalating waves (typically `TERM_SIGNAL` followed by
/// `KILL_SIGNAL` after a grace period). Process-group calls are no-ops
/// on platforms that do not expose process groups.
#[derive(Default)]
pub struct TerminationTargets {
	pgids:     Vec<i32>,
	processes: Vec<Process>,
	seen_pids: HashSet<i32>,
}

impl TerminationTargets {
	/// Create an empty target set.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a process group id. Duplicates are ignored.
	pub fn add_pgid(&mut self, pgid: i32) {
		if pgid > 0 && !self.pgids.contains(&pgid) {
			self.pgids.push(pgid);
		}
	}

	/// Record a pid. Duplicates are ignored. If the pid is alive, opens
	/// a stable [`Process`] reference so the descendant tree can be
	/// killed even if the original pid is reused later.
	///
	/// Prefer [`add_process`](Self::add_process) when the caller already holds a
	/// [`Process`] captured at spawn time: opening by pid here loses the
	/// original identity if the pid was recycled between the child exiting
	/// and this call.
	pub fn add_pid(&mut self, pid: i32) {
		if self.seen_pids.insert(pid)
			&& let Some(process) = Process::from_pid(pid)
		{
			self.processes.push(process);
		}
	}

	/// Record a pre-pinned [`Process`] handle. Duplicates (by pid) are ignored.
	///
	/// This is the correct entry point when the caller captured the handle at
	/// spawn time — the handle already pins OS-level identity, so no `from_pid`
	/// re-open (and its PID-reuse race) is needed at cancellation time.
	pub fn add_process(&mut self, process: Process) {
		if self.seen_pids.insert(process.pid()) {
			self.processes.push(process);
		}
	}

	/// True when no targets have been recorded.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.pgids.is_empty() && self.processes.is_empty()
	}

	/// Whether a process group is among the targets: one signal reaches all
	/// of it, with no read of the process table.
	#[must_use]
	pub const fn has_process_group(&self) -> bool {
		!self.pgids.is_empty()
	}

	/// Send `signal` to every recorded target. A target that already exited
	/// is no failure: targets routinely exit between collection and
	/// signalling, and the caller's policy is "best effort".
	///
	/// # Errors
	///
	/// The first tree whose walk could not read every process, once every
	/// target was signalled ([`Process::kill_tree`]).
	pub fn signal(&self, signal: i32) -> io::Result<()> {
		for &pgid in &self.pgids {
			let _ = kill_process_group(pgid, signal);
		}
		let mut complete = Ok(());
		for process in &self.processes {
			if let Err(error) = process.signal_tree(signal) {
				complete = complete.and(Err(error));
			}
		}
		complete
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The harness pid must be the only protected pid. Including its recorded
	/// parent would be unsafe on Windows: that stale numeric pid can have been
	/// recycled onto the timed-out command, causing cancellation to spare the
	/// hung target and its whole subtree.
	#[test]
	fn host_protected_pids_includes_self() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		assert_eq!(
			host_protected_pids(),
			HashSet::from([self_pid]),
			"only the harness pid may be protected from cancellation sweeps",
		);
	}

	/// Regression test for #7452: a cancellation sweep must never signal the
	/// protected host pid, even when it is enumerated as the sweep root. On
	/// Windows a recycled pid can make the harness surface as
	/// a false descendant of a just-spawned child; `TerminateProcess`-ing it
	/// killed the whole session with no `session_exit` record. The observable
	/// defense — provable cross-platform — is that `signal_tree_excluding`
	/// leaves a protected pid untouched.
	#[cfg(unix)]
	#[test]
	fn signal_tree_spares_protected_pids() {
		use std::{process::Command, thread, time::Duration};

		let mut child = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let child_pid = i32::try_from(child.id()).expect("child pid fits in i32");
		let root = Process::from_pid(child_pid).expect("pin child");

		// Treat the child's pid as protected (standing in for the harness/an
		// ancestor). The sweep must refuse to signal it.
		let protected: HashSet<i32> = HashSet::from([child_pid]);
		let signaled = root
			.signal_tree_excluding(KILL_SIGNAL, &protected)
			.expect("a whole walk");
		assert_eq!(signaled, 0, "a protected root must never be signalled");

		// The protected process is still alive after the sweep.
		thread::sleep(Duration::from_millis(50));
		assert_eq!(
			root.status(),
			ProcessStatus::Running,
			"a protected pid must survive a cancellation sweep",
		);

		// With no protection the same sweep reaps it — proves the skip is what
		// spared it, not a dead target.
		let reaped = root
			.signal_tree_excluding(KILL_SIGNAL, &HashSet::new())
			.expect("a whole walk");
		assert!(reaped >= 1, "an unprotected root must be signalled");
		let _ = child.wait();
	}

	/// Regression test for the #7453 review: pruning a protected node must drop
	/// its whole subtree, not just the exact protected pid. A Windows PID-reuse
	/// false-descendant collects the harness together with the harness's real
	/// children (LSP servers, worker/tool subprocesses); skipping only the host
	/// pid would still terminate those. `pid_in_protected_subtree` walks the
	/// enumerated parent map so any node under a protected pid is excluded.
	#[test]
	fn protected_subtree_is_pruned_not_just_the_pid() {
		// root(1) -> host(2, protected) -> worker(3); root(1) -> real_child(4).
		let parents: HashMap<i32, i32> = HashMap::from([(2, 1), (3, 2), (4, 1)]);
		let protected: HashSet<i32> = HashSet::from([2]);

		assert!(
			pid_in_protected_subtree(2, &protected, &parents),
			"the protected node itself must be excluded",
		);
		assert!(
			pid_in_protected_subtree(3, &protected, &parents),
			"a child collected through the protected node must be excluded too",
		);
		assert!(
			!pid_in_protected_subtree(4, &protected, &parents),
			"a real child of the sweep root must still be signalled",
		);
		assert!(
			!pid_in_protected_subtree(1, &protected, &parents),
			"the sweep root must not be pruned",
		);
	}

	/// Windows keeps the parent pid an orphan recorded, so after its parent
	/// exits the orphan is listed under whichever later process reuses that
	/// pid. The walk must not adopt it: an older process cannot be the child of
	/// a newer one, and a cancellation sweep would otherwise terminate an
	/// unrelated program.
	#[cfg(windows)]
	#[test]
	fn descendant_walk_skips_processes_older_than_their_listed_parent() {
		use std::{process::Command, thread, time::Duration};

		let spawn = || {
			Command::new("ping")
				.args(["-n", "30", "127.0.0.1"])
				.stdout(std::process::Stdio::null())
				.spawn()
				.expect("spawn sleeper")
		};
		let mut older = spawn();
		// Creation times have coarse granularity; keep the two apart.
		thread::sleep(Duration::from_millis(50));
		let mut newer = spawn();
		let (older_pid, newer_pid) = (older.id(), newer.id());
		let pin = |pid: u32| platform::Process::from_pid(i32::try_from(pid).unwrap()).unwrap();

		// A snapshot in which the older process names the newer one as its
		// parent, as it would after its own parent exited and the pid was reused.
		let tree = HashMap::from([(newer_pid, smallvec::SmallVec::from_slice(&[older_pid]))]);
		assert!(
			pin(newer_pid)
				.children_from_tree(&tree, &mut Walk::default())
				.is_empty(),
			"an older process is not a child"
		);

		// The same entry is accepted when the listed child is newer.
		let tree = HashMap::from([(older_pid, smallvec::SmallVec::from_slice(&[newer_pid]))]);
		let children = pin(older_pid).children_from_tree(&tree, &mut Walk::default());
		assert_eq!(
			children
				.iter()
				.map(platform::Process::pid)
				.collect::<Vec<_>>(),
			[i32::try_from(newer_pid).unwrap()]
		);

		let _ = older.kill();
		let _ = newer.kill();
		let _ = older.wait();
		let _ = newer.wait();
	}

	/// `open` tells a pid no process holds (`OpenProcess` gives
	/// `ERROR_INVALID_PARAMETER`) from a live process: `Ok(None)` once the
	/// child is reaped and its last handle closed, `Ok(Some)` while it runs;
	/// and a walk over a snapshot read whole is complete.
	#[cfg(windows)]
	#[test]
	fn open_tells_a_process_that_is_gone_from_a_live_one() {
		let mut child = std::process::Command::new("ping")
			.args(["-n", "30", "127.0.0.1"])
			.stdout(std::process::Stdio::null())
			.spawn()
			.expect("spawn sleeper");
		let pid = i32::try_from(child.id()).unwrap();
		let live = platform::Process::open(pid).expect("open a live child");
		assert!(live.as_ref().is_some_and(|process| process.pid() == pid));
		let me = platform::Process::open(i32::try_from(std::process::id()).unwrap())
			.unwrap()
			.unwrap();
		let walk = me.children();
		assert!(walk.complete.is_ok(), "{:?}", walk.complete);
		assert!(walk.processes.iter().any(|process| process.pid() == pid), "the child is not listed");
		drop((live, walk));
		let _ = child.kill();
		let _ = child.wait();
		drop(child);
		assert!(matches!(platform::Process::open(pid), Ok(None)), "the reaped child is not gone");
	}

	/// `kill_process_group` is the last line of defense: even if a future
	/// caller manages to feed the harness's own pgid into the signal path,
	/// this wrapper must refuse to deliver the signal.
	#[cfg(unix)]
	#[test]
	fn kill_process_group_refuses_self_pgroup() {
		// SAFETY: `getpgid(0)` queries the calling process and does not touch
		// caller-owned memory.
		let self_pgid = unsafe { libc::getpgid(0) };
		assert!(self_pgid > 0, "getpgid(0) failed");
		assert!(
			!kill_process_group(self_pgid, TERM_SIGNAL),
			"kill_process_group must refuse the harness pgid; otherwise the test process would have \
			 been SIGTERMed",
		);
		assert!(
			!kill_process_group(0, TERM_SIGNAL),
			"kill_process_group must reject non-positive pgids",
		);
	}

	/// Regression test for the macOS `proc_listchildpids` brokenness: on
	/// darwin 25.4+ the kernel returns no entries when a process queries its
	/// own children via that API, so `Process::descendants` produced an empty
	/// list and termination cleanup silently became a no-op. The replacement
	/// path scans `proc_listallpids` and groups by `pbi_ppid`, which actually
	/// works. Linux has always worked via `/proc`.
	#[cfg(unix)]
	#[test]
	fn descendants_includes_freshly_spawned_child() {
		use std::{process::Command, thread, time::Duration};

		let mut child = Command::new("sleep")
			.arg("10")
			.spawn()
			.expect("spawn sleep");
		let child_pid = i32::try_from(child.id()).expect("child pid fits in i32");

		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("harness Process ref");

		// Allow a few polling iterations so the kernel's process-table query
		// settles on a loaded host. proc_listallpids reflects newly forked pids
		// within milliseconds in practice; 1s is a comfortable upper bound.
		let mut found = false;
		for _ in 0..40 {
			let walk = harness.live_descendants();
			assert!(walk.complete.is_ok(), "{:?}", walk.complete);
			if walk
				.processes
				.iter()
				.any(|descendant| descendant.pid() == child_pid)
			{
				found = true;
				break;
			}
			thread::sleep(Duration::from_millis(25));
		}

		let _ = child.kill();
		let _ = child.wait();

		assert!(
			found,
			"freshly spawned child pid {child_pid} must appear in `live_descendants` so the \
			 cancellation cleanup can reach it; this regressed on macOS when the walk relied on the \
			 broken `proc_listchildpids`",
		);
	}

	/// `TerminationTargets::add_process` must accept a pre-pinned handle
	/// without going through `Process::from_pid`, so a caller that pinned the
	/// handle at spawn time avoids the PID-reuse race.
	#[cfg(unix)]
	#[test]
	fn add_process_bypasses_from_pid_lookup() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let pinned = Process::from_pid(self_pid).expect("pin self");

		let mut targets = TerminationTargets::new();
		targets.add_process(pinned.clone());
		assert!(!targets.is_empty(), "add_process must record the pinned handle");

		// Adding the same pid again through either entry point must dedupe:
		// otherwise every wave in `terminate_run` would re-signal the same
		// tree N times.
		targets.add_process(pinned);
		targets.add_pid(self_pid);
		assert_eq!(targets.processes.len(), 1, "duplicate pids must be deduped");
	}

	/// `wait_for_exit` on a lone process resolves when it exits, reports a
	/// timeout as `false`, and surfaces cancellation as an abort error.
	#[tokio::test(flavor = "multi_thread")]
	async fn wait_for_exit_resolves_times_out_and_aborts() {
		use std::process::Command;

		#[cfg(unix)]
		let mut child = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		#[cfg(windows)]
		let mut child = Command::new("ping")
			.args(["-n", "30", "127.0.0.1"])
			.stdout(std::process::Stdio::null())
			.spawn()
			.expect("spawn sleeper");
		let process = Process::from_pid(i32::try_from(child.id()).unwrap()).expect("pin child");

		let waited = process
			.wait_for_exit(Some(Duration::from_millis(100)), CancelToken::default())
			.await
			.expect("bounded wait");
		assert!(!waited, "a running process times out");

		let aborted = process
			.wait_for_exit(None, CancelToken::new(Some(100)))
			.await
			.expect_err("an expired token aborts the wait");
		assert_eq!(aborted.to_string(), "Aborted: Timeout");

		let waiter = {
			let process = process.clone();
			tokio::spawn(async move {
				process
					.wait_for_exit(Some(Duration::from_secs(20)), CancelToken::default())
					.await
			})
		};
		tokio::time::sleep(Duration::from_millis(50)).await;
		child.kill().expect("kill child");
		let exited = tokio::time::timeout(Duration::from_secs(5), waiter)
			.await
			.expect("the wait ends promptly after exit")
			.expect("waiter task")
			.expect("wait result");
		assert!(exited, "exit resolves the wait");
		let _ = child.wait();
	}

	/// What the broker relies on in `start_mark`: the same process pinned
	/// twice has the same mark, and a process known to have started earlier
	/// (this test's parent, and pid 1 where it can be pinned) has another.
	/// Nothing is asserted about two processes started together: on Linux
	/// the mark counts 10 ms clock ticks, and a mark names a process only
	/// with its pid.
	#[cfg(unix)]
	#[test]
	fn start_mark_names_one_process() {
		let mut child = crate::testkit::child::dies_with_this_process(
			std::process::Command::new("/bin/sleep").arg("600"),
		)
		.spawn()
		.expect("spawn sleep");
		let pid = i32::try_from(child.id()).unwrap();
		let (first, again) = (
			Process::from_pid(pid).expect("pin the child"),
			Process::from_pid(pid).expect("pin the child again"),
		);
		// SAFETY: getppid has no preconditions.
		let parent = Process::from_pid(unsafe { libc::getppid() }).expect("pin the test's parent");
		let init = Process::from_pid(1);
		let marks = (first.start_mark(), again.start_mark(), parent.start_mark());
		let init_mark = init.as_ref().map(Process::start_mark);
		let _ = child.kill();
		let _ = child.wait();
		let child_mark = marks.0.clone().expect("the child's mark");
		assert_eq!(marks.1.as_deref(), Some(child_mark.as_str()), "one process, one mark");
		let parent_mark = marks.2.expect("the parent's mark");
		assert_ne!(child_mark, parent_mark, "a process started earlier has another mark");
		if let Some(init_mark) = init_mark {
			assert_ne!(init_mark.as_deref(), Some(child_mark.as_str()), "pid 1 has another mark");
		}
		#[cfg(target_os = "linux")]
		{
			let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap();
			assert!(child_mark.starts_with(&format!("{}:", boot.trim())), "{child_mark}");
		}
	}

	/// The boot id is read once per process: once a mark was read, no later
	/// failure to read the boot id (here, no descriptor left) changes the
	/// mark of the same process. And in a process that never read it, a mark
	/// it cannot read is `None`, not another mark. Both run in child test
	/// processes ([`crate::sys::proc::short_of_descriptors`]).
	#[cfg(target_os = "linux")]
	#[test]
	fn a_boot_id_that_cannot_be_read_never_changes_a_mark() {
		use crate::sys::proc::short_of_descriptors;
		let mut child = crate::testkit::child::dies_with_this_process(
			std::process::Command::new("/bin/sleep").arg("600"),
		)
		.spawn()
		.expect("spawn sleep");
		let probed = [
			"proctree::tests::mark_read_again_with_no_descriptor_left",
			"proctree::tests::mark_never_read_with_no_descriptor_left",
		]
		.map(|test| short_of_descriptors::run(test, child.id()));
		let _ = child.kill();
		let _ = child.wait();
		for probed in probed {
			probed.unwrap();
		}
	}

	/// Run by [`a_boot_id_that_cannot_be_read_never_changes_a_mark`] in a
	/// child process: the mark read with descriptors, then again with none.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by a_boot_id_that_cannot_be_read_never_changes_a_mark"]
	fn mark_read_again_with_no_descriptor_left() {
		use crate::sys::proc::short_of_descriptors;
		let Some(pid) = short_of_descriptors::pid() else {
			return;
		};
		let pinned = Process::from_pid(pid).expect("pin the sleep");
		let before = pinned.start_mark().expect("the mark, with descriptors");
		short_of_descriptors::leave_none();
		assert!(
			std::fs::File::open("/proc/sys/kernel/random/boot_id").is_err(),
			"a file still opens"
		);
		assert_eq!(pinned.start_mark().as_deref(), Some(before.as_str()), "the mark changed");
	}

	/// Run by [`a_boot_id_that_cannot_be_read_never_changes_a_mark`] in a
	/// child process that has not read the boot id: with no descriptor left,
	/// the mark cannot be read.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by a_boot_id_that_cannot_be_read_never_changes_a_mark"]
	fn mark_never_read_with_no_descriptor_left() {
		use crate::sys::proc::short_of_descriptors;
		let Some(pid) = short_of_descriptors::pid() else {
			return;
		};
		let pinned = Process::from_pid(pid).expect("pin the sleep");
		short_of_descriptors::leave_none();
		assert_eq!(pinned.start_mark(), None, "a mark without the boot id");
	}

	/// A tree the walk cannot read (in a child test process with no
	/// descriptor left, [`crate::sys::proc::short_of_descriptors`]) is not
	/// passed over in silence: `kill_tree` kills what needs no read (the root,
	/// through its pidfd, and the process group the root leads) and fails
	/// with what it could not read. Here the root is `sh`, with a `sleep` in
	/// its own group, which dies with it; and then with both in the test's
	/// group, which the root does not lead: the sleep is then reported, not
	/// found. Without a pidfd only the group needs no read: a root that leads
	/// none cannot be signalled by a walk that cannot recheck its start
	/// time, so that case is skipped there, and says so.
	#[cfg(target_os = "linux")]
	#[test]
	fn kill_tree_kills_the_group_and_reports_a_walk_it_could_not_finish() {
		use std::{io::BufRead as _, os::unix::process::CommandExt as _};

		use crate::sys::proc::short_of_descriptors;
		let pidfd = short_of_descriptors::pidfd_available();
		for own_group in [true, false] {
			if !own_group && !pidfd {
				eprintln!(
					"skipped: without pidfd_open a root that leads no group cannot be signalled by a \
					 walk that cannot read its start time"
				);
				continue;
			}
			let mut command = std::process::Command::new("/bin/sh");
			command
				.args(["-c", "/bin/sleep 600 & echo $!; wait"])
				.stdout(std::process::Stdio::piped());
			if own_group {
				command.process_group(0);
			}
			let mut root = command.spawn().unwrap();
			let mut line = String::new();
			std::io::BufReader::new(root.stdout.take().unwrap())
				.read_line(&mut line)
				.unwrap();
			let sleep = Process::from_pid(line.trim().parse().unwrap()).expect("pin the sleep");
			let test = "proctree::tests::kill_tree_with_no_descriptor_left";
			let probed = short_of_descriptors::run(test, root.id());
			// The root is the parent test's child: its status says who killed
			// it. Waited for with no bound (the test runner's is the bound).
			let killed = loop {
				if let Some(status) = root.try_wait().unwrap() {
					break status;
				}
				std::thread::sleep(Duration::from_millis(10));
			};
			while own_group && sleep.status() == ProcessStatus::Running {
				std::thread::sleep(Duration::from_millis(10));
			}
			let sleep_ran_on = sleep.status() == ProcessStatus::Running;
			let _ = sleep.signal(KILL_SIGNAL);
			probed.unwrap_or_else(|error| panic!("own group {own_group}: {error}"));
			let killed_by = std::os::unix::process::ExitStatusExt::signal(&killed);
			assert_eq!(killed_by, Some(KILL_SIGNAL), "own group {own_group}: the root was not killed");
			if own_group {
				assert!(
					!sleep_ran_on,
					"the sleep in the root's group survived the walk it could not read"
				);
			}
		}
	}

	/// Where the system provides no pidfd (`pidfd_open` gives `ENOSYS`
	/// before Linux 5.3, or `EPERM` under a seccomp filter), a process is
	/// pinned by its start time instead of being reported unpinnable: it
	/// opens, `kill_tree` reads its tree whole and kills it, and it then reads
	/// as exited, as with a pidfd.
	#[cfg(target_os = "linux")]
	#[test]
	fn without_a_pidfd_a_process_is_pinned_by_its_start_time() {
		use std::io::BufRead as _;

		platform::NO_PIDFD.set(true);
		let mut root = crate::testkit::child::dies_with_this_process(
			std::process::Command::new("/bin/sh")
				.args(["-c", "/bin/sleep 600 & echo $!; wait"])
				.stdout(std::process::Stdio::piped()),
		)
		.spawn()
		.unwrap();
		let mut line = String::new();
		std::io::BufReader::new(root.stdout.take().unwrap())
			.read_line(&mut line)
			.unwrap();
		let sleep_pid: i32 = line.trim().parse().unwrap();
		let pinned = Process::open(i32::try_from(root.id()).unwrap())
			.expect("a missing pidfd is no error")
			.expect("the root runs");
		let sleep = Process::open(sleep_pid)
			.expect("no error")
			.expect("the sleep runs");
		let killed = pinned.kill_tree(Some(KILL_SIGNAL));
		let status = root.wait().unwrap();
		while sleep.status() == ProcessStatus::Running {
			std::thread::sleep(Duration::from_millis(10));
		}
		platform::NO_PIDFD.set(false);
		assert!(killed.as_ref().is_ok_and(|&n| n >= 2), "{killed:?}");
		let signal = std::os::unix::process::ExitStatusExt::signal(&status);
		assert_eq!(signal, Some(KILL_SIGNAL), "the root was killed");
		assert_eq!(pinned.status(), ProcessStatus::Exited, "the reaped root reads as exited");
		assert!(crate::sys::proc::ended(sleep_pid), "the sleep was killed");
	}

	/// Run by [`kill_tree_kills_the_group_and_reports_a_walk_it_could_not_finish`]
	/// in a child process: with no descriptor left, `kill_tree` of the root
	/// it names fails, saying what it could not read and whether it reached
	/// the root's group.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by \
	            kill_tree_kills_the_group_and_reports_a_walk_it_could_not_finish"]
	fn kill_tree_with_no_descriptor_left() {
		use crate::sys::proc::short_of_descriptors;
		let Some(pid) = short_of_descriptors::pid() else {
			return;
		};
		let root = Process::from_pid(pid).expect("pin the root");
		// SAFETY: plain syscall without pointer arguments.
		let leads_group = unsafe { libc::getpgid(pid) } == pid;
		short_of_descriptors::leave_none();
		let error = root
			.kill_tree(Some(KILL_SIGNAL))
			.expect_err("kill_tree reported a whole tree it could not read");
		let text = error.to_string();
		let unread = format!("cannot list the threads of process {pid}: Too many open files");
		assert!(text.starts_with(&unread), "{text}");
		assert_eq!(text.contains(&format!("and process group {pid}")), leads_group, "{text}");
		// No status check here: `poll` itself fails with no descriptor left.
	}
}
