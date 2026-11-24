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
		os::fd::{AsFd, AsRawFd, OwnedFd},
		sync::Arc,
	};

	use pi_builtins::proc_sys as sys;

	use super::{ProcessStatus, Walk, unread};

	/// Stable Linux process reference: a pidfd, or where the system provides
	/// none, the process's start time, rechecked before each use.
	#[derive(Clone)]
	pub struct Process {
		pid:        i32,
		/// `None` where `pidfd_open` is unavailable
		/// ([`sys::Pidfd::Unavailable`]): the process is then pinned by
		/// `start_time` alone, as `sys::proc::signal_pinned` does there.
		pidfd:      Option<Arc<OwnedFd>>,
		start_time: u64,
	}

	#[cfg(test)]
	thread_local! {
		/// Pin this thread's processes as where `pidfd_open` is unavailable.
		pub(crate) static NO_PIDFD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };

		/// Listing the threads of the paired pid on this thread fails with
		/// the paired `errno` while the process is still there: gVisor's
		/// `ENOENT` once the process's leader thread has exited, or a list
		/// the system refuses (`EACCES`), which Linux gives neither of.
		pub(crate) static FAIL_THREAD_LISTS: std::cell::RefCell<Vec<(i32, i32)>> =
			const { std::cell::RefCell::new(Vec::new()) };

		/// Reading the children of the paired thread id on this thread fails
		/// with the paired `errno`, as when that thread exits between the
		/// thread list and the read.
		pub(crate) static FAIL_CHILDREN_READS: std::cell::RefCell<Vec<(i32, i32)>> =
			const { std::cell::RefCell::new(Vec::new()) };

		/// Each `children` file read on this thread lists every thread of
		/// each child too, all by id, as gVisor's does on any kernel.
		pub(crate) static LIST_CHILD_THREADS: std::cell::Cell<bool> =
			const { std::cell::Cell::new(false) };

		/// Reading the status of the paired task id on this thread fails
		/// with the paired `errno`, which then takes the path a real
		/// failed read takes.
		pub(crate) static FAIL_STATUS_READS: std::cell::RefCell<Vec<(i32, i32)>> =
			const { std::cell::RefCell::new(Vec::new()) };

		/// A nonzero id each `children` file read on this thread lists
		/// too, as a task that ended since the kernel wrote the list.
		pub(crate) static LIST_ALSO: std::cell::Cell<i32> = const { std::cell::Cell::new(0) };
	}

	/// `Err` with the `errno` a test hook pairs with `id` in `fails`.
	#[cfg(test)]
	fn failed(
		fails: &'static std::thread::LocalKey<std::cell::RefCell<Vec<(i32, i32)>>>,
		id: i32,
	) -> io::Result<()> {
		fails.with_borrow(|fails| match fails.iter().find(|&&(at, _)| at == id) {
			Some(&(_, errno)) => Err(io::Error::from_raw_os_error(errno)),
			None => Ok(()),
		})
	}

	/// The entries of `/proc/<pid>/task`.
	fn list_threads(pid: i32) -> io::Result<fs::ReadDir> {
		#[cfg(test)]
		failed(&FAIL_THREAD_LISTS, pid)?;
		fs::read_dir(format!("/proc/{pid}/task"))
	}

	/// `/proc/<pid>/task/<tid>/children`.
	fn read_children(pid: i32, tid: &str) -> io::Result<String> {
		#[cfg(test)]
		failed(&FAIL_CHILDREN_READS, tid.parse().unwrap_or(0))?;
		let children = fs::read_to_string(format!("/proc/{pid}/task/{tid}/children"))?;
		#[cfg(test)]
		let children = if LIST_CHILD_THREADS.get() {
			with_their_threads(&children)
		} else {
			children
		};
		#[cfg(test)]
		let children = match LIST_ALSO.get() {
			0 => children,
			also => format!("{children} {also}"),
		};
		Ok(children)
	}

	/// `children`, a `children` file's list, with every other thread of each
	/// child added and the whole list sorted by id ([`LIST_CHILD_THREADS`]).
	#[cfg(test)]
	fn with_their_threads(children: &str) -> String {
		let mut listed: Vec<i32> = Vec::new();
		for child in children.split_whitespace() {
			listed.push(child.parse().expect("a children file lists ids"));
			let tasks = fs::read_dir(format!("/proc/{child}/task"));
			for task in tasks.into_iter().flatten().flatten() {
				let tid = task.file_name().to_string_lossy().into_owned();
				if tid != child {
					listed.push(tid.parse().expect("a task directory is named by its id"));
				}
			}
		}
		listed.sort_unstable();
		listed
			.iter()
			.map(i32::to_string)
			.collect::<Vec<_>>()
			.join(" ")
	}

	/// The process the task `id` is a thread of (`Tgid` in
	/// `/proc/<id>/status`): `id` itself for a process (its leading thread),
	/// another id for any other of its threads; `Ok(None)` when no signal
	/// of ours reaches `id` any more ([`crate::sys::proc::read`]'s rule).
	///
	/// Linux and gVisor both make a thread a child process starts a child
	/// task of the child's parent (`CLONE_THREAD` takes the creator's
	/// parent), but Linux links only a thread group's leader into its
	/// parent's children, while gVisor links every task
	/// (`kernel/task_start.go`). So gVisor's
	/// `/proc/<pid>/task/<tid>/children` lists every thread of a child
	/// process, sorted by id among the other children
	/// (`fsimpl/proc/task_files.go`), where Linux lists the child alone.
	///
	/// The status is read as bytes: its first line is the task's name,
	/// which can hold any bytes (`prctl(PR_SET_NAME)`, or a name cut at 15
	/// bytes inside a character). gVisor writes that name as it is, a
	/// newline included, where Linux escapes it (`fsimpl/proc/task_files.go`,
	/// `fs/proc/array.c`), so a name can add a `Tgid:` line of its own before
	/// the real one; the last `Tgid:` line is the kernel's.
	///
	/// Where `pidfd_open` is unavailable (`ENOSYS`, `EPERM`) a listed thread
	/// pins by its start time and never reaches this: it is taken for a
	/// child, and a kill of the tree signals its process once for each such
	/// thread.
	fn thread_group(id: i32) -> io::Result<Option<i32>> {
		#[cfg(test)]
		let hooked = failed(&FAIL_STATUS_READS, id);
		#[cfg(not(test))]
		let hooked: io::Result<()> = Ok(());
		match hooked.and_then(|()| fs::read(format!("/proc/{id}/status"))) {
			Ok(status) => status
				.split(|&byte| byte == b'\n')
				// From the end: the first `Tgid:` line found is the kernel's.
				.rev()
				.find_map(|line| {
					std::str::from_utf8(line.strip_prefix(b"Tgid:")?)
						.ok()?
						.trim()
						.parse()
						.ok()
				})
				.map(Some)
				.ok_or_else(|| io::ErrorKind::InvalidData.into()),
			Err(error) if crate::sys::proc::out_of_reach(id, &error) => Ok(None),
			Err(error) => Err(error),
		}
	}

	/// `pidfd_open(pid)`, sorted ([`crate::sys::proc::pidfd_open`]).
	fn pidfd_open(pid: i32) -> io::Result<sys::Pidfd> {
		#[cfg(test)]
		if NO_PIDFD.get() {
			return Ok(sys::Pidfd::Unavailable);
		}
		crate::sys::proc::pidfd_open(pid, None)
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
			let pidfd = match pidfd_open(pid)? {
				sys::Pidfd::Open(fd) => Some(Arc::new(fd)),
				sys::Pidfd::Gone => return Ok(None),
				sys::Pidfd::Unavailable => None,
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
			let mut seen: HashSet<i32> = HashSet::new();
			let mut children_file_available = false;
			// The thread list was gone while `/proc` still showed this process
			// ([`Self::thread_list_gone`]), or a thread left between the list
			// and the read of its children, which the kernel then gave to
			// another thread, maybe one already read: the children are found
			// by their parent instead.
			let mut by_parent = false;
			match list_threads(self.pid) {
				Ok(entries) => {
					for entry in entries {
						let entry = match entry {
							Ok(entry) => entry,
							Err(error) if self.thread_list_gone(&error) => {
								by_parent = true;
								break;
							},
							Err(error) => {
								self.note(&mut walk, &error, "list the threads of");
								continue;
							},
						};
						let name = entry.file_name();
						let Some(tid) = name.to_str().filter(|tid| tid.parse::<i32>().is_ok()) else {
							continue;
						};
						match read_children(self.pid, tid) {
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
								if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) =>
							{
								by_parent = true;
							},
							Err(error) => self.note(&mut walk, &error, "read the children of"),
						}
					}
				},
				Err(error) if self.thread_list_gone(&error) => by_parent = true,
				Err(error) => self.note(&mut walk, &error, "list the threads of"),
			}

			// Some Kata / microVM guest kernels are built without
			// CONFIG_PROC_CHILDREN, so no `.../children` file exists and the
			// walk above finds nothing — which would silently turn descendant
			// signaling (cancellation cleanup) into a no-op inside such
			// containers. Fall back to scanning `/proc` and grouping
			// by parent pid, the same primitive the macOS path uses. Only taken
			// when no `children` file was readable, or a thread list or file
			// was gone, so kernels that support it keep the cheap per-task
			// fast path.
			if (!children_file_available || by_parent)
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

		/// Whether `error`, a failure to list this process's threads, says
		/// only that the list is gone while `/proc` still shows this process,
		/// read by its start time. gVisor answers `ENOENT` from the moment the
		/// leader thread (the one whose id is the pid) exits, while the
		/// process runs on until its last thread exits, and its pidfd reads
		/// as running until then (`fsimpl/proc/subtasks.go`,
		/// `kernel/pidfd.go`); Linux, only once the process is reaped, when
		/// the pidfd reads as exited. A process `/proc` does not show (no
		/// `/proc`, another pid namespace's, one `hidepid` hides) was not
		/// read, which proves nothing.
		fn thread_list_gone(&self, error: &io::Error) -> bool {
			matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH))
				&& matches!(
					crate::sys::proc::read(self.pid),
					Ok(Some(info)) if info.start == self.start_time
				)
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
		/// fallback (kernels without `CONFIG_PROC_CHILDREN`, or a thread list
		/// gone from `/proc`). A candidate that cannot be pinned or read makes
		/// the walk incomplete, unless it is a thread of another process:
		/// gVisor's `children` file lists every thread of a child process
		/// ([`thread_group`]), and `pidfd_open` refuses a thread that leads
		/// no thread group. Such a thread stands for its process, which is
		/// validated instead. Where `pidfd_open` is unavailable (`ENOSYS`,
		/// `EPERM`) the thread pins by its start time instead, its parent is
		/// `self`, and it is taken for a child: a kill of the tree then
		/// signals its process once for each such thread.
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
				Err(error) => match thread_group(child_pid) {
					Ok(Some(process)) if process != child_pid => {
						self.push_validated_child(process, seen, walk);
					},
					// Gone since it was listed.
					Ok(None) => {},
					Ok(Some(_)) => walk.fail(unread(
						&error,
						format_args!(
							"cannot read process {child_pid}, a possible child of process {}",
							self.pid
						),
					)),
					Err(status) => walk.fail(unread(
						&status,
						format_args!(
							"cannot read the status of process {child_pid}, a possible child of process \
							 {}",
							self.pid
						),
					)),
				},
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

		/// True once every thread of the process has stopped (`T`, or `t` under
		/// a tracer), or the process has ended. A thread stops only on its way
		/// back to user space, so a `fork` it was making when the stop signal
		/// came has returned by then, and its child is in [`Self::children`].
		/// A process that ended, or whose threads cannot be read, has nothing
		/// left to wait for.
		pub fn stopped(&self) -> bool {
			self.every_thread(&['T', 't', 'Z', 'X'])
		}

		/// True once every thread of the process sleeps in the kernel (`S` or
		/// `D`), or the process has ended.
		pub fn asleep(&self) -> bool {
			self.every_thread(&['S', 'D', 'Z', 'X'])
		}

		/// Whether the state of every thread (`/proc/<pid>/task/*/stat`) is one
		/// of `states`; true once the process has ended or its threads cannot
		/// be read.
		fn every_thread(&self, states: &[char]) -> bool {
			if !self.live_identity() {
				return true;
			}
			let Ok(tasks) = fs::read_dir(format!("/proc/{}/task", self.pid)) else {
				return true;
			};
			tasks.flatten().all(|task| {
				// A thread that ended after the listing has no stat left to read.
				let Ok(stat) = read_lossy(task.path().join("stat")) else {
					return true;
				};
				// The state follows the command name, which may itself hold `)`.
				let state = stat
					.rfind(')')
					.and_then(|end| stat[end + 1..].trim_start().chars().next());
				state.is_some_and(|state| states.contains(&state))
			})
		}

		/// Whether every thread of the running process blocks `signal`
		/// (`SigBlk` in `/proc/<pid>/task/*/status`). Sent to the process, a
		/// blocked signal stays pending: the process runs on once resumed until
		/// a thread unblocks it, and can fork meanwhile. `None` when the system
		/// shows no masks (gVisor writes no `SigBlk` line); SIGKILL is never
		/// blocked; an ended process blocks nothing.
		pub fn blocks(&self, signal: i32) -> Option<bool> {
			if signal == libc::SIGKILL {
				return Some(false);
			}
			let Some(bit) = u32::try_from(signal - 1)
				.ok()
				.and_then(|shift| 1u64.checked_shl(shift))
			else {
				return Some(false);
			};
			let Ok(tasks) = fs::read_dir(format!("/proc/{}/task", self.pid)) else {
				return Some(false);
			};
			let mut threads = 0_usize;
			for task in tasks.flatten() {
				// A thread that ended after the listing blocks nothing.
				let Ok(status) = read_lossy(task.path().join("status")) else {
					continue;
				};
				let mask = status
					.lines()
					.find_map(|line| line.strip_prefix("SigBlk:"))?;
				let mask = u64::from_str_radix(mask.trim(), 16).ok()?;
				if mask & bit == 0 {
					return Some(false);
				}
				threads += 1;
			}
			Some(threads > 0 && self.live_identity())
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

	/// Whether process group `pgid` holds a process that has not ended and
	/// that this process may signal, both read of the same process. A zombie
	/// does not count: it has ended, and waits only for its parent to collect
	/// its status. `None` when the answer may be wrong: `/proc` could not be
	/// listed, or a process's stat file could not be read for a reason other
	/// than the process having ended (out of descriptors, say).
	pub fn group_has_live_member(pgid: i32) -> Option<bool> {
		let entries = list_proc(pgid).ok()?;
		let mut complete = true;
		for entry in entries {
			let Ok(entry) = entry else {
				complete = false;
				continue;
			};
			let Some(pid) = entry
				.file_name()
				.to_str()
				.and_then(|name| name.parse::<i32>().ok())
			else {
				continue;
			};
			let stat = match read_stat(pid) {
				Ok(stat) => stat,
				Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => {
					continue;
				},
				Err(_) => {
					complete = false;
					continue;
				},
			};
			// The state and the group follow the command name, which may itself
			// hold `)`.
			let Some(end) = stat.rfind(')') else {
				continue;
			};
			let mut fields = stat[end + 1..].split_whitespace();
			let state = fields.next();
			let group = fields.nth(1).and_then(|field| field.parse::<i32>().ok());
			if group != Some(pgid) || matches!(state, Some("Z" | "X")) {
				continue;
			}
			// SAFETY: kill with signal 0 takes scalars and only checks that the
			// process exists and may be signalled.
			if unsafe { libc::kill(pid, 0) } == 0 {
				return Some(true);
			}
		}
		complete.then_some(false)
	}

	/// `/proc/<pid>/stat`. A test can make the read fail for one process.
	fn read_stat(pid: i32) -> std::io::Result<String> {
		#[cfg(test)]
		if super::proc_read_fault::stat_fails(pid) {
			return Err(std::io::Error::from_raw_os_error(libc::EMFILE));
		}
		read_lossy(format!("/proc/{pid}/stat"))
	}

	/// `path` read whole, with bytes that are not UTF-8 replaced. A process's
	/// name (`comm`) may hold any bytes: the kernel cuts it at 15 bytes, inside
	/// a character too, and writes it into `stat` and `status` unescaped. A
	/// read that refused such a file would hide the fields after the name.
	fn read_lossy(path: impl AsRef<std::path::Path>) -> std::io::Result<String> {
		fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
	}

	/// The entries of `/proc`. A test can make the listing fail for one group.
	fn list_proc(pgid: i32) -> std::io::Result<fs::ReadDir> {
		#[cfg(test)]
		if super::proc_read_fault::fails(pgid) {
			return Err(std::io::Error::from_raw_os_error(libc::EMFILE));
		}
		#[cfg(not(test))]
		let _ = pgid;
		fs::read_dir("/proc")
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

	/// Whether process group `pgid` holds a process that has not ended and
	/// that this process may signal, both read of the same process. A zombie
	/// (`SZOMB`) does not count: it has ended, and waits only for its parent to
	/// collect its status. `None` when no process could be listed. libproc
	/// does not say why a process's record cannot be read, so a process whose
	/// record fails is read as not a member.
	pub fn group_has_live_member(pgid: i32) -> Option<bool> {
		const SZOMB: u32 = 5;
		let pids = sys::pids();
		if pids.is_empty() {
			return None;
		}
		Some(pids.into_iter().any(|pid| {
			let member = sys::bsdinfo(pid).is_some_and(|info| {
				i32::try_from(info.pbi_pgid).ok() == Some(pgid) && info.pbi_status != SZOMB
			});
			// SAFETY: kill with signal 0 takes scalars and only checks that the
			// process exists and may be signalled.
			member && unsafe { libc::kill(pid, 0) } == 0
		}))
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
	/// the wait entirely (the polite signal is still emitted). The polite wave
	/// is sent even when `ct` has already fired. Returns `true` when the tree
	/// has exited by the end of the hard wave's wait window.
	///
	/// On Linux each wave stops a tree in a process group of its own, top-down,
	/// before it reads it, and resumes it once signalled, so a process cannot
	/// fork a child between the walk and its own signal: such a child used to
	/// outlive the termination, moved to init when its parent died. A stopped
	/// process that blocks the wave's signal is stepped until it unblocks it,
	/// so a child it forks in that window (dash blocks every signal around
	/// each vfork) is read too; stepping one process ends after 100 ms, so a
	/// process that blocks the signal and sleeps or runs longer than that
	/// before it forks still leaves its child running, and one that waits for
	/// the signal with it blocked (tini) takes those 100 ms. Where no signal
	/// masks are shown (gVisor), a stopped process is read as it is, so one
	/// stopped while it blocks the signal forks on after the wave resumes it
	/// until it unblocks the signal, and those children outlive the
	/// termination unless `group` ends them: `fork` in glibc 2.41 and later
	/// blocks every signal around its `clone`, so a process stopped in that
	/// window makes one more child. Each level of the tree waits up to
	/// 100 ms for its processes to stop; one that has not stopped by then is
	/// read as it runs. The walk holds a pidfd for each process it reads; a
	/// child whose pidfd cannot be opened (out of descriptors) leaves the walk
	/// incomplete, as below.
	///
	/// A tree in the caller's own process group is not stopped, so it keeps
	/// the plain walk and its race: a child forked while the walk reads can
	/// outlive the termination there. On gVisor before google/gvisor 553528ee
	/// a stopped member of the caller's group brings SIGHUP to the caller as
	/// another member is reaped. A caller that needs the fix runs the tree in
	/// a process group of its own (`detached` in ptree).
	///
	/// The hard wave signals every process the polite wave signalled that
	/// still runs, and the tree under each, besides the tree it reads again,
	/// so a child that outlived its parent's TERM (one that ignores TERM, or
	/// was stopped) is ended, and so are the children it forked since.
	///
	/// A wave whose walk could not read the whole tree also signals the
	/// process group the root leads, if any (it needs no read); and the call
	/// fails once the hard wave is sent if its walk was incomplete, since a
	/// descendant it could not read may still run.
	///
	/// Without a grace period (`graceful_ms < 0`) the polite wave steps no
	/// process: the signal has no time to act before the KILL.
	///
	/// With `group`, both waits also last until the process group holds no
	/// process that has not ended, so the grace period runs in full while any
	/// member ignores TERM, and the hard wave's wait sends the group its KILL
	/// again on each tick (every 50 ms, each a scan of the process table) while
	/// one is left. A process that left the tree is ended through the group:
	/// one forked during the grace period by a process that then exited (in a
	/// TERM handler, say), which moved to the nearest subreaper or to init
	/// where no walk reads it; one orphaned before the walk; and one the
	/// group's signal missed as it was forked (seen under gVisor). A group
	/// whose members cannot be read counts as alive. A process
	/// that left the group (`setsid`, `setpgid`) is reached by neither; a
	/// subreaper reaches it. Without `group`, a child forked during the grace
	/// period by a process that then exited still outlives the termination.
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
		wait_for_exit(self, &[], None, timeout, ct).await
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

	/// The tree under this process, read for one termination wave that sends
	/// `signal`.
	///
	/// Level by level from the top, each process is stopped before its
	/// children are read, and the walk waits until it has stopped
	/// ([`platform::Process::stopped`]): a stopped process cannot fork, so no
	/// process joins the tree between this walk and the wave's signal.
	///
	/// No process of the caller's own process group is stopped. Where a
	/// stopped member of a group brings SIGHUP and SIGCONT to every member as
	/// another member is reaped (gVisor before google/gvisor 553528ee), the
	/// caller would be hung up with it. A tree in the caller's group is
	/// therefore read as it runs, as before this walk stopped anything, so a
	/// child one of its processes forks during the walk can still outlive the
	/// termination; the walk holds a tree in a process group of its own.
	///
	/// A process that was already stopped is read as it is and left stopped:
	/// it cannot fork, and its resume is not the walk's to give.
	///
	/// A stopped process that blocks `signal` in every thread would not act on
	/// it once resumed: it would run on until a thread unblocks it, and could
	/// fork meanwhile (dash blocks every signal around each vfork). Such a
	/// process is stepped: resumed, left to run until it sleeps in the kernel,
	/// forks or unblocks the signal ([`Self::step`]), and stopped again, until
	/// it no longer blocks the signal or [`STEP_LIMIT`] has passed for it. A
	/// child it forks on the way is read with the others. A process that
	/// waits for the signal with it blocked (tini, a `sigwaitinfo` or signalfd
	/// reader) takes its whole limit. Where the system shows no signal masks
	/// (gVisor), a stopped process is read as it is. Without `steps` (the
	/// polite wave of a call with no grace period, where the signal has no
	/// time to act before the KILL) no process is stepped.
	///
	/// Each level waits up to [`STOP_WAIT_LIMIT`] for its processes to stop; a
	/// process that has not stopped by then (one blocked in the kernel, or
	/// traced with its stops suppressed) is read as it runs. A protected
	/// process is neither stopped nor walked into, so its subtree is spared.
	/// The walk takes no cancellation: its waits are bounded. A child list
	/// that cannot be read leaves the walk incomplete, as
	/// [`Self::signalable_descendants`] does.
	#[cfg(target_os = "linux")]
	async fn freeze(&self, signal: i32, protected: &HashSet<i32>, steps: bool) -> Frozen {
		// SAFETY: getpgrp takes no arguments and cannot fail.
		let own_group = unsafe { libc::getpgrp() };
		let mut frozen = Frozen { walk: Walk::default(), stopped: Vec::new() };
		let mut visited = HashSet::from([self.pid()]);
		let mut level = vec![self.clone()];
		while !level.is_empty() {
			let deadline = tokio::time::Instant::now() + STOP_WAIT_LIMIT;
			let stopping = frozen.stopped.len();
			for process in &level {
				if protected.contains(&process.pid())
					|| process.group_id() == Some(own_group)
					|| process.inner.stopped()
				{
					continue;
				}
				if process.inner.kill(libc::SIGSTOP) {
					frozen.stopped.push(process.clone());
					#[cfg(all(test, target_os = "linux"))]
					wave_hook::run_stop_sent(process.pid());
				}
			}
			while !frozen.stopped[stopping..]
				.iter()
				.all(|process| process.inner.stopped())
				&& tokio::time::Instant::now() < deadline
			{
				tokio::time::sleep(STOP_POLL_INTERVAL).await;
			}
			for process in frozen.stopped[stopping..].iter().filter(|_| steps) {
				let limit = tokio::time::Instant::now() + STEP_LIMIT;
				while process.inner.blocks(signal) == Some(true) && tokio::time::Instant::now() < limit
				{
					#[cfg(all(test, target_os = "linux"))]
					wave_hook::count_step(self.pid());
					process.step(signal, limit).await;
				}
			}
			let mut next = Vec::new();
			for process in &level {
				let children = process.inner.children();
				if let Err(error) = children.complete {
					frozen.walk.fail(error);
				}
				for child in children.processes.into_iter().map(Self::from_inner) {
					if !protected.contains(&child.pid()) && visited.insert(child.pid()) {
						next.push(child.clone());
						frozen.walk.processes.push(child);
					}
				}
			}
			level = next;
		}
		// Level by level, reversed: every child before its parent.
		frozen.walk.processes.reverse();
		frozen
	}

	/// One step of a stopped process that blocks `signal`: resume it and wait
	/// until it has left the stopped state; then wait, until `limit`, for it to
	/// sleep in the kernel, have another number of children, no longer block
	/// `signal` or end; then stop it again and wait up to [`STOP_WAIT_LIMIT`]
	/// for it to stop.
	#[cfg(target_os = "linux")]
	async fn step(&self, signal: i32, limit: tokio::time::Instant) {
		let children = self.inner.children().processes.len();
		let _ = self.inner.kill(libc::SIGCONT);
		while self.inner.stopped()
			&& self.inner.children().processes.len() == children
			&& tokio::time::Instant::now() < limit
		{
			tokio::time::sleep(STOP_POLL_INTERVAL).await;
		}
		while tokio::time::Instant::now() < limit
			&& self.inner.children().processes.len() == children
			&& self.inner.blocks(signal) == Some(true)
			&& !self.inner.asleep()
		{
			tokio::time::sleep(STOP_POLL_INTERVAL).await;
		}
		let _ = self.inner.kill(libc::SIGSTOP);
		let stop_by = tokio::time::Instant::now() + STOP_WAIT_LIMIT;
		while !self.inner.stopped() && tokio::time::Instant::now() < stop_by {
			tokio::time::sleep(STOP_POLL_INTERVAL).await;
		}
	}

	/// The tree under this process, read for one termination wave, with every
	/// protected subtree pruned. Nothing is stopped outside Linux.
	#[cfg(not(target_os = "linux"))]
	fn freeze(
		&self,
		_signal: i32,
		protected: &HashSet<i32>,
		_steps: bool,
	) -> std::future::Ready<Frozen> {
		std::future::ready(Frozen { walk: self.signalable_descendants(protected) })
	}

	/// One signal wave on the tree `frozen` read: the group (`group`, or the
	/// one the root leads when the walk is incomplete), every live descendant,
	/// then the root. Returns the walk, for the wait. The processes the walk
	/// stopped resume once it is dropped, here, and act on the signal then.
	fn signal_wave(
		&self,
		mut frozen: Frozen,
		signal: i32,
		group: Option<i32>,
		protected: &HashSet<i32>,
	) -> Walk<Self> {
		#[cfg(all(test, target_os = "linux"))]
		wave_hook::run(self.pid());
		if let Some(pgid) = group {
			let _ = kill_process_group(pgid, signal);
		}
		let descendants = std::mem::take(&mut frozen.walk);
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
		#[cfg(all(test, target_os = "linux"))]
		wave_hook::run_after(self.pid(), signal);
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
		// It is sent even when `ct` has already fired: cancellation ends the
		// waits, not the signal.
		let frozen = self.freeze(TERM_SIGNAL, &protected, graceful_ms >= 0).await;
		let polite = self.signal_wave(frozen, TERM_SIGNAL, process_group, &protected);

		// Optional grace wait. A negative `graceful_ms` skips the wait entirely
		// (we still emit the polite signal so cleanup handlers can run before
		// KILL). An incomplete walk proves no exit: the hard wave follows.
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				self,
				&polite.processes,
				process_group.map(|pgid| GroupWait { pgid, resend: None }),
				Some(Duration::from_millis(graceful_ms as u64)),
				ct.clone(),
			)
			.await?;
			if exited && polite.complete.is_ok() {
				return Ok(true);
			}
		}

		// Hard wave. Re-walk the tree so any grandchild spawned during the grace
		// period — or any process re-parented to the root — is signalled too,
		// along with every process the polite wave signalled that still runs,
		// and the tree under each: one whose parent died has left the tree,
		// and no walk from the root reaches it or what it forked since.
		let mut frozen = self.freeze(KILL_SIGNAL, &protected, true).await;
		for survivor in frozen.survivors(polite.processes) {
			if frozen.holds(survivor.pid()) {
				continue;
			}
			let subtree = survivor.freeze(KILL_SIGNAL, &protected, true).await;
			frozen.absorb(subtree, survivor);
		}
		let hard = self.signal_wave(frozen, KILL_SIGNAL, process_group, &protected);
		let group = process_group.map(|pgid| GroupWait { pgid, resend: Some(KILL_SIGNAL) });
		let exited = wait_for_exit(
			self,
			&hard.processes,
			group,
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

/// How long one level of a wave's walk waits for the processes it stopped to
/// stop. A runnable process stops within microseconds of the signal.
#[cfg(target_os = "linux")]
const STOP_WAIT_LIMIT: Duration = Duration::from_millis(100);

/// How often [`Process::freeze`] looks again at the processes it is waiting
/// on.
#[cfg(target_os = "linux")]
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(1);

/// How long [`Process::freeze`] steps one stopped process that blocks the
/// wave's signal, in all.
#[cfg(target_os = "linux")]
const STEP_LIMIT: Duration = Duration::from_millis(100);

/// The processes one termination wave signals, read by [`Process::freeze`].
/// Dropping it resumes the ones it stopped, so no way out of a wave, a
/// cancelled one included, leaves a process stopped.
struct Frozen {
	/// Children before parents, the order the wave signals them in.
	walk:    Walk<Process>,
	/// Top-down, in the order they were stopped.
	#[cfg(target_os = "linux")]
	stopped: Vec<Process>,
}

impl Frozen {
	/// The processes of `earlier` (an earlier wave's) that still run and that
	/// this walk did not read: each one's parent died, so it left the tree.
	fn survivors(&self, earlier: Vec<Process>) -> Vec<Process> {
		earlier
			.into_iter()
			.filter(|process| !self.holds(process.pid()) && process.status() == ProcessStatus::Running)
			.collect()
	}

	/// Whether this walk holds `pid` among the processes it signals.
	fn holds(&self, pid: i32) -> bool {
		self
			.walk
			.processes
			.iter()
			.any(|process| process.pid() == pid)
	}

	/// Put `subtree` (the walk of `root`) and `root` ahead of the descendants,
	/// each process once, and take over the processes `subtree` stopped, so
	/// they resume once this wave is signalled. A subtree walk that could not
	/// read its whole tree leaves this walk incomplete too.
	fn absorb(&mut self, mut subtree: Self, root: Process) {
		let walk = std::mem::take(&mut subtree.walk);
		if let Err(error) = walk.complete {
			self.walk.fail(error);
		}
		let mut held: HashSet<i32> = self.walk.processes.iter().map(Process::pid).collect();
		let mut added: Vec<Process> = walk
			.processes
			.into_iter()
			.filter(|process| held.insert(process.pid()))
			.collect();
		if held.insert(root.pid()) {
			added.push(root);
		}
		self.walk.processes.splice(0..0, added);
		#[cfg(target_os = "linux")]
		self.stopped.append(&mut subtree.stopped);
	}
}

#[cfg(target_os = "linux")]
impl Drop for Frozen {
	fn drop(&mut self) {
		// Children first: a parent resumed later finds them already acting on
		// the wave's signal.
		for process in self.stopped.iter().rev() {
			let _ = process.inner.kill(libc::SIGCONT);
		}
	}
}

/// Lets a test act right after a wave's SIGSTOP to a process, between a
/// wave's walk and its signal, or right after the signal.
#[cfg(all(test, target_os = "linux"))]
mod wave_hook {
	use std::{
		collections::HashMap,
		sync::{LazyLock, Mutex},
	};

	type Hook = Box<dyn FnOnce() + Send>;

	static HOOKS: LazyLock<Mutex<HashMap<i32, Hook>>> = LazyLock::new(Mutex::default);
	static AFTER: LazyLock<Mutex<HashMap<(i32, i32), Hook>>> = LazyLock::new(Mutex::default);

	/// Run `hook` once, in the next wave on the tree under `root`.
	pub fn set(root: i32, hook: Hook) {
		HOOKS.lock().expect("wave hooks").insert(root, hook);
	}

	pub fn run(root: i32) {
		let hook = HOOKS.lock().expect("wave hooks").remove(&root);
		if let Some(hook) = hook {
			hook();
		}
	}

	/// Run `hook` once, right after the next wave on the tree under `root`
	/// that sends `signal` has sent it.
	pub fn set_after(root: i32, signal: i32, hook: Hook) {
		AFTER
			.lock()
			.expect("wave hooks")
			.insert((root, signal), hook);
	}

	pub fn run_after(root: i32, signal: i32) {
		let hook = AFTER.lock().expect("wave hooks").remove(&(root, signal));
		if let Some(hook) = hook {
			hook();
		}
	}

	static STOP_SENT: LazyLock<Mutex<HashMap<i32, Hook>>> = LazyLock::new(Mutex::default);

	/// Run `hook` once, right after a wave has sent SIGSTOP to `pid`.
	pub fn set_stop_sent(pid: i32, hook: Hook) {
		STOP_SENT.lock().expect("wave hooks").insert(pid, hook);
	}

	pub fn run_stop_sent(pid: i32) {
		let hook = STOP_SENT.lock().expect("wave hooks").remove(&pid);
		if let Some(hook) = hook {
			hook();
		}
	}

	static STEPS: LazyLock<Mutex<HashMap<i32, usize>>> = LazyLock::new(Mutex::default);

	/// Count one step taken by a wave on the tree under `root`.
	pub fn count_step(root: i32) {
		*STEPS.lock().expect("step counts").entry(root).or_default() += 1;
	}

	/// The steps taken by the waves on the tree under `root`.
	pub fn steps(root: i32) -> usize {
		STEPS
			.lock()
			.expect("step counts")
			.get(&root)
			.copied()
			.unwrap_or(0)
	}
}

/// Lets a test make the listing of `/proc` fail for the group scan of one
/// process group, or the read of one process's stat file fail.
#[cfg(all(test, target_os = "linux"))]
mod proc_read_fault {
	use std::{
		collections::HashSet,
		sync::{LazyLock, Mutex},
	};

	static FAILING: LazyLock<Mutex<HashSet<i32>>> = LazyLock::new(Mutex::default);

	pub fn set(pgid: i32) {
		FAILING.lock().expect("faults").insert(pgid);
	}

	pub fn fails(pgid: i32) -> bool {
		FAILING.lock().expect("faults").contains(&pgid)
	}

	static STAT: LazyLock<Mutex<HashSet<i32>>> = LazyLock::new(Mutex::default);

	pub fn set_stat(pid: i32) {
		STAT.lock().expect("faults").insert(pid);
	}

	pub fn stat_fails(pid: i32) -> bool {
		STAT.lock().expect("faults").contains(&pid)
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

/// The process group a wait for a terminated tree also waits on, and the
/// signal the wait sends the group again while a member is left.
#[derive(Clone, Copy)]
struct GroupWait {
	pgid:   i32,
	resend: Option<i32>,
}

/// Whether the root and the descendants have ended.
fn tree_ended(root: &Process, descendants: &[Process]) -> bool {
	root.status() != ProcessStatus::Running
		&& descendants
			.iter()
			.all(|process| process.status() != ProcessStatus::Running)
}

async fn wait_for_exit(
	root: &Process,
	descendants: &[Process],
	group: Option<GroupWait>,
	timeout: Option<Duration>,
	ct: CancelToken,
) -> Result<bool> {
	ct.heartbeat()?;
	if tree_ended(root, descendants) && group.is_none_or(|group| !group_alive(group.pgid)) {
		return Ok(true);
	}

	// A lone process is awaited through the OS exit notification. Polling woke
	// every waiter 20 times a second, and IPC workers wait on their parent for
	// their whole life. Trees and groups still poll: their membership changes.
	if descendants.is_empty()
		&& group.is_none()
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

		let group_left = group.filter(|group| group_alive(group.pgid));
		if tree_ended(root, descendants) && group_left.is_none() {
			return Ok(true);
		}
		// Only while the group still holds a live member: an empty group's id
		// can be reused.
		if let Some(GroupWait { pgid, resend: Some(signal) }) = group_left {
			let _ = kill_process_group(pgid, signal);
		}
	}

	Ok(false)
}

/// Whether process group `pgid` still holds a process that has not ended and
/// that this process may signal. A group whose members cannot be read counts
/// as alive, so the wait goes on to its bound and the hard wave goes out.
/// There are no process groups on Windows.
fn group_alive(pgid: i32) -> bool {
	#[cfg(unix)]
	{
		// A cheap first answer: fails once the group is empty, zombies
		// included, or holds no process this one may signal, and refuses the
		// caller's own group. The scan then reads the members themselves.
		kill_process_group(pgid, 0) && platform::group_has_live_member(pgid) != Some(false)
	}
	#[cfg(not(unix))]
	{
		let _ = pgid;
		false
	}
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
	/// `ERROR_INVALID_PARAMETER`) from a live process, and an exited process
	/// from a running one; and a walk over a snapshot read whole is complete.
	///
	/// Windows does not free a killed child's process object at the moment
	/// the last handle to it closes: for a short while after, with no other
	/// process holding a handle, its pid still opens. Such an open gives the
	/// process with its status exited, which is all a walk relies on
	/// ([`Process::child`] keeps only a running child). Here a second handle
	/// of the test's own keeps the object for certain; once that closes, the
	/// pid is gone, not yet freed (the child, exited), or reused (another
	/// creation time), and never the child running.
	#[cfg(windows)]
	#[test]
	fn open_tells_a_process_that_is_gone_from_a_live_one() {
		let mut child = std::process::Command::new("ping")
			.args(["-n", "30", "127.0.0.1"])
			.stdout(std::process::Stdio::null())
			.spawn()
			.expect("spawn sleeper");
		let pid = i32::try_from(child.id()).unwrap();
		let held = platform::Process::open(pid)
			.expect("open a live child")
			.expect("the live child opens");
		assert_eq!(held.pid(), pid);
		assert_eq!(held.status(), ProcessStatus::Running);
		let started = held.start_ticks();
		let me = platform::Process::open(i32::try_from(std::process::id()).unwrap())
			.unwrap()
			.unwrap();
		let walk = me.children();
		assert!(walk.complete.is_ok(), "{:?}", walk.complete);
		assert!(walk.processes.iter().any(|process| process.pid() == pid), "the child is not listed");
		drop(walk);
		let _ = child.kill();
		let _ = child.wait();
		drop(child);
		// `held` keeps the object: the pid opens as the child, exited, and no
		// walk lists it.
		let exited = platform::Process::open(pid)
			.expect("open the exited child")
			.expect("the held child opens");
		assert_eq!(exited.start_ticks(), started, "the held pid is the child's");
		assert_eq!(exited.status(), ProcessStatus::Exited, "the killed child reads as exited");
		let walk = me.children();
		assert!(walk.complete.is_ok(), "{:?}", walk.complete);
		assert!(
			!walk.processes.iter().any(|process| process.pid() == pid),
			"the exited child is listed"
		);
		drop((held, exited, walk));
		match platform::Process::open(pid) {
			Ok(None) => {},
			Ok(Some(process)) => assert!(
				process.start_ticks() != started || process.status() == ProcessStatus::Exited,
				"the killed child reads as running"
			),
			Err(error) => panic!("open the killed child's pid: {error}"),
		}
		// A pid far beyond those Windows gives: no process holds it.
		assert!(matches!(platform::Process::open(0x7fff_fffc), Ok(None)), "a pid no process holds");
	}

	/// A kernel before 6.16 answers `pidfd_open` with `EINVAL` for a pid whose
	/// process was reaped after the call found it. Injected here: `open`
	/// reports the reaped child gone, and a live process the same `EINVAL`
	/// cannot pin is an error, not a process gone.
	#[cfg(target_os = "linux")]
	#[test]
	fn open_counts_a_pidfd_einval_as_gone_only_for_a_reaped_process() {
		let spawn = || {
			std::process::Command::new("sleep")
				.arg("30")
				.spawn()
				.expect("spawn sleeper")
		};
		let mut reaped = spawn();
		let gone = i32::try_from(reaped.id()).unwrap();
		let _ = reaped.kill();
		let _ = reaped.wait();
		let mut live = spawn();
		let running = i32::try_from(live.id()).unwrap();
		let fails =
			crate::sys::proc::fail_pidfds(vec![(gone, libc::EINVAL), (running, libc::EINVAL)]);
		let reaped_open = platform::Process::open(gone);
		let live_open = platform::Process::open(running);
		drop(fails);
		let _ = live.kill();
		let _ = live.wait();
		assert!(
			matches!(reaped_open, Ok(None)),
			"the reaped child is not gone: {:?}",
			reaped_open.map(|p| p.map(|p| p.pid()))
		);
		let error = live_open
			.map(|p| p.map(|p| p.pid()))
			.expect_err("an EINVAL for a running process counted as gone");
		assert_eq!(error.raw_os_error(), Some(libc::EINVAL), "{error}");
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
		// The wait's own limit is 20 s; the exit resolves it first, or `exited`
		// is false.
		let exited = waiter.await.expect("waiter task").expect("wait result");
		assert!(exited, "exit resolves the wait");
		let _ = child.wait();
	}

	/// What the broker relies on in `start_mark`: the same process pinned
	/// twice has the same mark, and a process known to have started earlier
	/// (this test's parent, and pid 1 where it can be pinned) has another.
	/// Nothing is asserted about two processes started together: on Linux
	/// the mark counts 10 ms clock ticks, and a mark names a process only
	/// with its pid. So the child is started only once a thread started
	/// here is in a later tick than the parent, both read from their `stat`
	/// here: a parent that forked the test binary at once (a wrapper such as
	/// `timeout`) shared the child's tick, and the marks were equal.
	#[cfg(unix)]
	#[test]
	fn start_mark_names_one_process() {
		// SAFETY: getppid has no preconditions.
		let ppid = unsafe { libc::getppid() };
		let parent = Process::from_pid(ppid).expect("pin the test's parent");
		// The test's own reading of both ticks, so the wait ends however the
		// product reads them and the marks below are what is checked.
		#[cfg(target_os = "linux")]
		{
			let parent_ticks = start_ticks_in(&format!("/proc/{ppid}/stat"));
			while std::thread::spawn(|| start_ticks_in("/proc/thread-self/stat"))
				.join()
				.unwrap()
				<= parent_ticks
			{}
		}
		let mut child = crate::testkit::child::dies_with_this_process(
			std::process::Command::new("sleep").arg("600"),
		)
		.spawn()
		.expect("spawn sleep");
		let pid = i32::try_from(child.id()).unwrap();
		let (first, again) = (
			Process::from_pid(pid).expect("pin the child"),
			Process::from_pid(pid).expect("pin the child again"),
		);
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

	/// The start time in a task's `stat` at `path`: field 22, clock ticks
	/// since boot, the count and the unit of Linux's start mark.
	#[cfg(target_os = "linux")]
	fn start_ticks_in(path: &str) -> u64 {
		let stat = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{path}: {error}"));
		// Field 3, the state, is the first after the name.
		stat
			.rsplit_once(") ")
			.and_then(|(_, rest)| rest.split(' ').nth(22 - 3)?.parse().ok())
			.unwrap_or_else(|| panic!("{path}: no start time in {stat:?}"))
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
			std::process::Command::new("sleep").arg("600"),
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
				.args(["-c", "sleep 600 & echo $!; wait"])
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
		// The root `exec`s a second sleep once its child is gone: when the KILL
		// to the child lands first (on a loaded machine), the root does not
		// leave `wait` and exit by itself before its own KILL arrives, so only
		// that KILL ends it.
		let mut root = crate::testkit::child::dies_with_this_process(
			std::process::Command::new("/bin/sh")
				.args(["-c", "sleep 600 & echo $!; wait; exec sleep 600"])
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

	/// Starts `sh`, which runs a `sleep 600` and waits for it, then `exec`s
	/// a second `sleep 600`, so that only a KILL of its own ends it; in a
	/// process group of its own when `own_group`. Returns the `sh` and the
	/// first sleep's pid.
	#[cfg(target_os = "linux")]
	fn sh_with_a_sleep(own_group: bool) -> (std::process::Child, i32) {
		use std::{io::BufRead as _, os::unix::process::CommandExt as _};

		let mut command = std::process::Command::new("sh");
		command
			.args(["-c", "sleep 600 & echo $!; wait; exec sleep 600"])
			.stdout(std::process::Stdio::piped());
		if own_group {
			command.process_group(0);
		}
		let mut root = crate::testkit::child::dies_with_this_process(&mut command)
			.spawn()
			.unwrap();
		let mut line = String::new();
		std::io::BufReader::new(root.stdout.take().unwrap())
			.read_line(&mut line)
			.unwrap();
		(root, line.trim().parse().unwrap())
	}

	/// gVisor answers a listing of `/proc/<pid>/task` with `ENOENT` from the
	/// moment the process's leader thread exits, while the process, and so
	/// its pidfd, runs on until its last thread exits
	/// (`fsimpl/proc/subtasks.go`, `kernel/pidfd.go`). A kill that met a
	/// multi-threaded daemon in that state refused: `cannot list the threads
	/// of process N: No such file or directory`. Here the root's thread list
	/// gives that answer while the root runs: the walk finds the root's
	/// child by its parent, so `kill_tree` kills both and succeeds.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_thread_list_gone_from_proc_finds_the_children_by_their_parent() {
		let (mut root, sleep_pid) = sh_with_a_sleep(false);
		let root_pid = i32::try_from(root.id()).unwrap();
		let pinned = Process::from_pid(root_pid).expect("pin the root");
		let sleep = Process::from_pid(sleep_pid).expect("pin the sleep");
		platform::FAIL_THREAD_LISTS.set(vec![(root_pid, libc::ENOENT)]);
		let killed = pinned.kill_tree(Some(KILL_SIGNAL));
		platform::FAIL_THREAD_LISTS.take();
		if !matches!(killed, Ok(2)) {
			let _ = sleep.signal(KILL_SIGNAL);
		}
		let status = root.wait().unwrap();
		assert!(matches!(killed, Ok(2)), "the root and its sleep: {killed:?}");
		let signal = std::os::unix::process::ExitStatusExt::signal(&status);
		assert_eq!(signal, Some(KILL_SIGNAL), "the root was killed");
		while sleep.status() == ProcessStatus::Running {
			std::thread::sleep(Duration::from_millis(10));
		}
	}

	/// A thread list the walk cannot read while the process is still there
	/// proves nothing, so `kill_tree` still fails, naming it, once it has
	/// killed the root and the group the root leads: a list the system
	/// refuses (`EACCES`), and an `ENOENT` for a process `/proc` does not
	/// show either (no `/proc`, another pid namespace's, or one `hidepid`
	/// hides: here its `stat` read fails too).
	#[cfg(target_os = "linux")]
	#[test]
	fn a_thread_list_the_walk_cannot_read_fails_the_kill() {
		for (errno, stat_hidden, said) in [
			(libc::EACCES, false, "Permission denied"),
			(libc::ENOENT, true, "No such file or directory"),
		] {
			let (mut root, sleep_pid) = sh_with_a_sleep(true);
			let root_pid = i32::try_from(root.id()).unwrap();
			let pinned = Process::from_pid(root_pid).expect("pin the root");
			let sleep = Process::from_pid(sleep_pid).expect("pin the sleep");
			platform::FAIL_THREAD_LISTS.set(vec![(root_pid, errno)]);
			let hidden =
				stat_hidden.then(|| crate::sys::proc::fail_reads(vec![(Some(root_pid), libc::ENOENT)]));
			let killed = pinned.kill_tree(Some(KILL_SIGNAL));
			drop(hidden);
			platform::FAIL_THREAD_LISTS.take();
			let status = root.wait().unwrap();
			// The sleep is in the root's group, which needs no read.
			while sleep.status() == ProcessStatus::Running {
				std::thread::sleep(Duration::from_millis(10));
			}
			let text = killed
				.expect_err("kill_tree reported a whole tree it could not read")
				.to_string();
			let unread = format!("cannot list the threads of process {root_pid}: {said}");
			assert!(text.starts_with(&unread), "{text}");
			assert!(text.contains(&format!("and process group {root_pid}")), "{text}");
			let signal = std::os::unix::process::ExitStatusExt::signal(&status);
			assert_eq!(signal, Some(KILL_SIGNAL), "{said}: the root was killed");
		}
	}

	/// The variable that lets [`a_thread_that_forked_a_sleep`] run.
	#[cfg(target_os = "linux")]
	const FORKING_THREAD: &str = "PI_SHELL_TEST_FORKING_THREAD";

	/// A child is listed in the `children` file of the thread that forked
	/// it. When that thread exits between the thread list and the read of
	/// its file, the kernel gives its children to another thread of the
	/// process, whose file the walk may have read already: the walk then
	/// missed the child, and reported a whole tree. Here the root is a test
	/// process whose second thread forked a `sleep`, and the read of that
	/// thread's file fails as when the thread has exited. The walk finds
	/// the sleep by its parent, so `kill_tree` kills both.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_thread_that_left_before_its_children_were_read_loses_no_child() {
		use std::io::BufRead as _;

		let mut root = crate::testkit::child::dies_with_this_process(
			std::process::Command::new(std::env::current_exe().unwrap())
				.args([
					"--exact",
					"proctree::tests::a_thread_that_forked_a_sleep",
					"--ignored",
					"--nocapture",
					"--test-threads=1",
				])
				.env(FORKING_THREAD, "1")
				.stdout(std::process::Stdio::piped()),
		)
		.spawn()
		.unwrap();
		// The harness writes `test <name> ... ` before the test runs, so the
		// helper's words follow it on the same line.
		let forked = std::io::BufReader::new(root.stdout.take().unwrap())
			.lines()
			.map(Result::unwrap)
			.find_map(|line| {
				let (tid, sleep) = line.split_once("FORKED ")?.1.split_once(' ')?;
				Some((tid.parse::<i32>().unwrap(), sleep.parse::<i32>().unwrap()))
			});
		let (tid, sleep_pid) = forked.expect("the root's thread forked a sleep");
		let root_pid = i32::try_from(root.id()).unwrap();
		let pinned = Process::from_pid(root_pid).expect("pin the root");
		let sleep = Process::from_pid(sleep_pid).expect("pin the sleep");
		platform::FAIL_CHILDREN_READS.set(vec![(tid, libc::ENOENT)]);
		let killed = pinned.kill_tree(Some(KILL_SIGNAL));
		platform::FAIL_CHILDREN_READS.take();
		if !matches!(killed, Ok(2)) {
			let _ = sleep.signal(KILL_SIGNAL);
		}
		let status = root.wait().unwrap();
		assert!(matches!(killed, Ok(2)), "the root and its sleep: {killed:?}");
		let signal = std::os::unix::process::ExitStatusExt::signal(&status);
		assert_eq!(signal, Some(KILL_SIGNAL), "the root was killed");
		while sleep.status() == ProcessStatus::Running {
			std::thread::sleep(Duration::from_millis(10));
		}
	}

	/// Run by [`a_thread_that_left_before_its_children_were_read_loses_no_child`]
	/// in a child process: a second thread forks a `sleep 600`, prints its
	/// own thread id and the sleep's pid, and waits for the sleep; the first
	/// thread waits until the process is killed.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by \
	            a_thread_that_left_before_its_children_were_read_loses_no_child"]
	fn a_thread_that_forked_a_sleep() {
		if std::env::var_os(FORKING_THREAD).is_none() {
			return;
		}
		std::thread::spawn(|| {
			let mut sleep = std::process::Command::new("sleep")
				.arg("600")
				.stdout(std::process::Stdio::null())
				.spawn()
				.unwrap();
			// SAFETY: gettid takes no arguments.
			let tid = unsafe { libc::gettid() };
			println!("FORKED {tid} {}", sleep.id());
			let _ = sleep.wait();
			loop {
				std::thread::park();
			}
		});
		loop {
			std::thread::park();
		}
	}

	/// The variable that lets [`a_second_thread_until_stdin_closes`] run.
	#[cfg(target_os = "linux")]
	const SECOND_THREAD: &str = "PI_SHELL_TEST_SECOND_THREAD";

	/// gVisor's `children` file lists every thread of a child process, by id
	/// among the other children, and `pidfd_open` refuses such a thread with
	/// `ENOENT` (it leads no thread group). The walk took each for a child
	/// it could not read, so under gVisor the walk of a process with a
	/// two-thread child was never complete, and a kill of its tree failed;
	/// in the whole test binary, another test's child test process made
	/// [`descendants_includes_freshly_spawned_child`] fail. Here the root is
	/// `sh`, whose one child is a test process with a second thread whose
	/// name is not UTF-8 and, under gVisor, adds a `Tgid:` line naming the
	/// thread itself ahead of the kernel's: the walk is complete and finds that
	/// child once, by its pid, with the `children` files as the kernel writes
	/// them, and with every thread of each child listed too, as gVisor writes
	/// them. Where `pidfd_open` is unavailable a listed thread pins by its start
	/// time and is taken for a child, a limit this keeps. A child that
	/// cannot be read for a reason that proves nothing still fails the
	/// walk, and so does a thread whose status cannot be read, with the
	/// status read's error; a candidate gone by the time its status is read
	/// is skipped.
	#[cfg(target_os = "linux")]
	#[test]
	fn threads_of_a_child_are_not_children() {
		use std::io::BufRead as _;

		let mut root = crate::testkit::child::dies_with_this_process(
			std::process::Command::new("/bin/sh")
				// Not the last command: `sh` forks it rather than `exec`.
				.args(["-c", "\"$0\" \"$@\"; exit $?"])
				.arg(std::env::current_exe().unwrap())
				.args([
					"--exact",
					"proctree::tests::a_second_thread_until_stdin_closes",
					"--ignored",
					"--nocapture",
					"--test-threads=1",
				])
				.env(SECOND_THREAD, "1")
				.stdin(std::process::Stdio::piped())
				.stdout(std::process::Stdio::piped()),
		)
		.spawn()
		.unwrap();
		let mut lines = std::io::BufReader::new(root.stdout.take().unwrap()).lines();
		// The harness writes `test <name> ... ` before the test runs, so the
		// helper's words follow it on the same line.
		let (child, thread) = lines
			.by_ref()
			.map(Result::unwrap)
			.find_map(|line| {
				let (pid, tid) = line.split_once("SECOND ")?.1.split_once(' ')?;
				Some((pid.parse::<i32>().unwrap(), tid.parse::<i32>().unwrap()))
			})
			.expect("the child started its second thread");
		let name = std::fs::read(format!("/proc/{child}/task/{thread}/comm"));
		// Every task of the child (the harness's thread runs the helper, so
		// there are more than two), by id, as a listing that takes each
		// thread for a child has them.
		let mut tasks: Vec<i32> = std::fs::read_dir(format!("/proc/{child}/task"))
			.unwrap()
			.map(|task| task.unwrap().file_name().to_str().unwrap().parse().unwrap())
			.collect();
		tasks.sort_unstable();
		let pidfds = crate::sys::proc::short_of_descriptors::pidfd_available();
		// gVisor's own `children` file lists the thread already.
		let kernel_lists_threads =
			std::fs::read_to_string(format!("/proc/{0}/task/{0}/children", root.id()))
				.is_ok_and(|listed| listed.split_whitespace().any(|id| id == thread.to_string()));
		let root_pid = i32::try_from(root.id()).unwrap();
		let pinned = platform::Process::from_pid(root_pid).expect("pin the root");
		let walk = |as_gvisor: bool, no_pidfd: bool| {
			platform::LIST_CHILD_THREADS.set(as_gvisor);
			platform::NO_PIDFD.set(no_pidfd);
			let walk = pinned.children();
			platform::LIST_CHILD_THREADS.set(false);
			platform::NO_PIDFD.set(false);
			let pids: Vec<i32> = walk.processes.iter().map(|process| process.pid()).collect();
			(walk.complete.map_err(|error| error.to_string()), pids)
		};
		let as_kernel = walk(false, false);
		let as_gvisor = walk(true, false);
		let as_gvisor_without_pidfds = walk(true, true);
		// A child that cannot be read for a reason that proves nothing (no
		// descriptor left for its pidfd) still leaves the walk incomplete.
		let refused = {
			let fails = crate::sys::proc::fail_pidfds(vec![(child, libc::EMFILE)]);
			let walk = pinned.children();
			drop(fails);
			walk.complete.map_err(|error| error.to_string())
		};
		// So does a listed thread whose status cannot be read.
		let status_refused = {
			platform::FAIL_STATUS_READS.set(vec![(thread, libc::EMFILE)]);
			let walk = walk(true, false);
			platform::FAIL_STATUS_READS.set(Vec::new());
			walk.0
		};
		// A listed candidate that cannot be pinned (no descriptor left) and is
		// gone when its status is read is skipped. A test hook lists it as the
		// kernel would have a task that ended a moment ago, by an id no process
		// can have (Linux allocates pids below 2^22): a pid this test reaped
		// itself could be given to a new process before the walk reads it, and
		// that process, unpinnable through the hook, failed the walk.
		let gone = i32::MAX;
		let gone_since_listed = {
			platform::LIST_ALSO.set(gone);
			let fails = crate::sys::proc::fail_pidfds(vec![(gone, libc::EMFILE)]);
			let walk = walk(false, false);
			drop(fails);
			platform::LIST_ALSO.set(0);
			walk
		};
		drop(root.stdin.take());
		let said: Vec<String> = lines.map(Result::unwrap).collect();
		let status = root.wait().unwrap();
		assert!(
			status.success() && said.iter().any(|line| line.contains("1 passed")),
			"the child test did not pass: {said:?}"
		);
		assert_ne!(child, thread, "the second thread is the child's own");
		let name = name.expect("read the second thread's name");
		assert!(
			std::str::from_utf8(&name).is_err(),
			"the second thread's name is not UTF-8: {name:?}"
		);
		let unread = format!("cannot read process {child}, a possible child of process {root_pid}");
		assert!(
			refused
				.as_ref()
				.is_err_and(|error| error.starts_with(&unread)),
			"{refused:?}"
		);
		// A thread pinned by its start time is taken for a child.
		let kernel = if pidfds || !kernel_lists_threads {
			vec![child]
		} else {
			tasks.clone()
		};
		assert_eq!(
			as_kernel,
			(Ok(()), kernel.clone()),
			"the children files as the kernel writes them, pidfds {pidfds}"
		);
		assert_eq!(
			gone_since_listed,
			(Ok(()), kernel),
			"a candidate gone since it was listed, {gone}"
		);
		let taken = if pidfds { vec![child] } else { tasks.clone() };
		assert_eq!(
			as_gvisor,
			(Ok(()), taken),
			"every thread listed, pidfds {pidfds}; thread {thread}"
		);
		assert_eq!(as_gvisor_without_pidfds, (Ok(()), tasks), "every thread listed, no pidfds");
		if pidfds {
			let unread = format!(
				"cannot read the status of process {thread}, a possible child of process {root_pid}: \
				 {}",
				crate::bash::diag::strerror(&io::Error::from_raw_os_error(libc::EMFILE))
			);
			assert!(
				status_refused.as_ref().is_err_and(|error| *error == unread),
				"{status_refused:?}"
			);
		}
	}

	/// Run by [`threads_of_a_child_are_not_children`] in a child process: a
	/// second thread, named with bytes that are not UTF-8 and a `Tgid:` line
	/// of its own, waits for this process's standard input to close, once
	/// the line `SECOND <pid> <its thread id>` says it runs.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by threads_of_a_child_are_not_children"]
	fn a_second_thread_until_stdin_closes() {
		if std::env::var_os(SECOND_THREAD).is_none() {
			return;
		}
		let (started, running) = std::sync::mpsc::channel();
		let second = std::thread::spawn(move || {
			// SAFETY: gettid takes no arguments.
			let tid = unsafe { libc::gettid() };
			// The first byte of a character with none after it, then a
			// `Tgid:` line naming this thread itself: at most 15 bytes, which
			// gVisor puts in the status as they are.
			let mut name = vec![0xe8];
			name.extend_from_slice(format!("\nTgid:\t{tid}").as_bytes());
			let name = std::ffi::CString::new(name).unwrap();
			// SAFETY: `name` is NUL-terminated and outlives the call, which
			// names only this thread.
			assert_eq!(unsafe { libc::prctl(libc::PR_SET_NAME, name.as_ptr()) }, 0);
			started.send(tid).unwrap();
			let _ = std::io::Read::read(&mut std::io::stdin(), &mut [0]);
		});
		println!("SECOND {} {}", std::process::id(), running.recv().unwrap());
		second.join().unwrap();
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

	/// The state letter of `pid`'s main thread: `T` once it has stopped.
	#[cfg(target_os = "linux")]
	fn thread_state(pid: i32) -> Option<char> {
		let stat = std::fs::read(format!("/proc/{pid}/stat")).ok()?;
		let stat = String::from_utf8_lossy(&stat);
		stat[stat.rfind(')')? + 1..].trim_start().chars().next()
	}

	/// Whether this system shows signal masks (`SigBlk` in
	/// `/proc/<pid>/status`); gVisor does not, and the walk steps no process
	/// there.
	#[cfg(target_os = "linux")]
	fn masks_shown() -> bool {
		std::fs::read_to_string("/proc/self/status").is_ok_and(|status| status.contains("\nSigBlk:"))
	}

	/// Set by a [`spawn_term_blocker`] root's SIGCONT handler, in the root's
	/// own copy of this process's memory.
	#[cfg(target_os = "linux")]
	static CONTINUED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

	#[cfg(target_os = "linux")]
	extern "C" fn on_continued(_: libc::c_int) {
		CONTINUED.store(true, std::sync::atomic::Ordering::SeqCst);
	}

	/// What a [`spawn_term_blocker`] root waits for before it forks.
	#[cfg(target_os = "linux")]
	#[derive(Clone, Copy)]
	enum BeforeFork {
		/// To be continued from a stop, as a wave's step continues it; it
		/// spins until then.
		Continued,
		/// A pending SIGTERM, polled every millisecond.
		TermPending,
		/// That many milliseconds asleep in the kernel, with no SIGCONT
		/// handler: a handler would end the sleep at each step's resume, and
		/// the remaining time it sleeps again would leave out the time stopped.
		Sleep(i64),
	}

	/// Forks a root, in a process group of its own, that blocks SIGTERM and
	/// then waits as `before_fork` says. Then it forks `/bin/sleep 1000`,
	/// writes that child's pid to the returned pipe, unblocks SIGTERM when
	/// `unblock`, and waits for the child. Returns once the root has blocked
	/// SIGTERM (and set its SIGCONT handler, for `Continued`). Only
	/// async-signal-safe calls run after the fork: the test process has other
	/// threads.
	#[cfg(target_os = "linux")]
	fn spawn_term_blocker(before_fork: BeforeFork, unblock: bool) -> (i32, std::os::fd::OwnedFd) {
		use std::{ffi::CStr, os::fd::FromRawFd, ptr, sync::atomic::Ordering};

		const SLEEP: &CStr = c"/bin/sleep";
		let argv = [SLEEP.as_ptr(), c"1000".as_ptr(), ptr::null()];
		let mut pipe = [0; 2];
		let mut ready = [0; 2];
		// SAFETY: each array has room for the two descriptors pipe2 writes.
		unsafe {
			assert_eq!(libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC), 0, "pipe");
			assert_eq!(libc::pipe2(ready.as_mut_ptr(), libc::O_CLOEXEC), 0, "ready pipe");
		}
		// SAFETY: the child runs only async-signal-safe calls on memory made
		// before the fork, and leaves by `execv` or `_exit`.
		let root = unsafe { libc::fork() };
		assert!(root >= 0, "fork the root");
		if root == 0 {
			// SAFETY: as above; every pointer names a live local of this frame.
			unsafe {
				// The walk stops no process of the caller's group.
				libc::setpgid(0, 0);
				// A handler the test process installed would run in this copy.
				libc::signal(libc::SIGTERM, libc::SIG_DFL);
				let mut term: libc::sigset_t = std::mem::zeroed();
				libc::sigemptyset(&raw mut term);
				libc::sigaddset(&raw mut term, libc::SIGTERM);
				libc::sigprocmask(libc::SIG_BLOCK, &raw const term, ptr::null_mut());
				if matches!(before_fork, BeforeFork::Continued) {
					let mut action: libc::sigaction = std::mem::zeroed();
					action.sa_sigaction =
						on_continued as extern "C" fn(libc::c_int) as libc::sighandler_t;
					libc::sigemptyset(&raw mut action.sa_mask);
					libc::sigaction(libc::SIGCONT, &raw const action, ptr::null_mut());
				}
				libc::write(ready[1], [1u8].as_ptr().cast(), 1);
				libc::close(ready[1]);
				match before_fork {
					BeforeFork::TermPending => loop {
						let mut pending: libc::sigset_t = std::mem::zeroed();
						libc::sigpending(&raw mut pending);
						if libc::sigismember(&raw const pending, libc::SIGTERM) == 1 {
							break;
						}
						let tick = libc::timespec { tv_sec: 0, tv_nsec: 1_000_000 };
						libc::nanosleep(&raw const tick, ptr::null_mut());
					},
					BeforeFork::Continued => {
						while !CONTINUED.load(Ordering::SeqCst) {
							std::hint::spin_loop();
						}
					},
					BeforeFork::Sleep(ms) => {
						let left =
							libc::timespec { tv_sec: ms / 1000, tv_nsec: (ms % 1000) * 1_000_000 };
						libc::nanosleep(&raw const left, ptr::null_mut());
					},
				}
				let child = libc::fork();
				if child == 0 {
					let mut none: libc::sigset_t = std::mem::zeroed();
					libc::sigemptyset(&raw mut none);
					libc::sigprocmask(libc::SIG_SETMASK, &raw const none, ptr::null_mut());
					libc::execv(SLEEP.as_ptr(), argv.as_ptr());
					libc::_exit(127);
				}
				libc::write(pipe[1], (&raw const child).cast(), size_of::<libc::pid_t>());
				if unblock {
					libc::sigprocmask(libc::SIG_UNBLOCK, &raw const term, ptr::null_mut());
				}
				let mut status = 0;
				libc::waitpid(child, &raw mut status, 0);
				libc::_exit(0);
			}
		}
		let mut byte = 0u8;
		// SAFETY: the write ends are this process's own descriptors, closed
		// once; `byte` has room for the one byte read. The read returns at
		// the root's write, or at 0 if the root ended first.
		let got = unsafe {
			libc::close(pipe[1]);
			libc::close(ready[1]);
			let got = libc::read(ready[0], (&raw mut byte).cast(), 1);
			libc::close(ready[0]);
			got
		};
		assert_eq!(got, 1, "the root blocked SIGTERM");
		// SAFETY: the read end is this process's own descriptor, owned from here.
		(root, unsafe { std::os::fd::OwnedFd::from_raw_fd(pipe[0]) })
	}

	/// The child pid a [`spawn_term_blocker`] root wrote, once the root has
	/// ended, and whether that child still runs; it is killed if so. Reaps
	/// the root.
	#[cfg(target_os = "linux")]
	fn reap_term_blocker(root: i32, pipe: &std::os::fd::OwnedFd) -> bool {
		use std::os::fd::AsRawFd;

		let mut status = 0;
		// SAFETY: `root` is this process's child, and `status` outlives the call.
		unsafe { libc::waitpid(root, &raw mut status, 0) };
		let mut child: libc::pid_t = 0;
		// SAFETY: `child` has room for the bytes read.
		let read =
			unsafe { libc::read(pipe.as_raw_fd(), (&raw mut child).cast(), size_of::<libc::pid_t>()) };
		assert_eq!(
			usize::try_from(read).ok(),
			Some(size_of::<libc::pid_t>()),
			"the root forked its child"
		);
		let child = Process::from_pid(child);
		let runs = child
			.as_ref()
			.is_some_and(|child| child.status() == ProcessStatus::Running);
		if let Some(child) = &child {
			let _ = child.signal(KILL_SIGNAL);
		}
		runs
	}

	/// Kills process group `.0` on drop, so a failing test leaves none of
	/// its processes running.
	#[cfg(target_os = "linux")]
	struct GroupGuard(i32);

	#[cfg(target_os = "linux")]
	impl Drop for GroupGuard {
		fn drop(&mut self) {
			// SAFETY: kill takes scalars; the group is the test root's own.
			unsafe { libc::kill(-self.0, libc::SIGKILL) };
		}
	}

	/// Waits, up to 10 s, until `done` holds; panics naming `what` otherwise.
	#[cfg(target_os = "linux")]
	fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
		while !done() {
			assert!(std::time::Instant::now() < deadline, "timed out waiting until {what}");
			std::thread::sleep(std::time::Duration::from_millis(1));
		}
	}

	/// Reaps `child`, waiting up to 10 s for it to end, then kills and reaps
	/// it: a test whose tree survived fails, it does not hang.
	#[cfg(target_os = "linux")]
	fn reap(child: &mut std::process::Child) -> std::process::ExitStatus {
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
		loop {
			if let Some(status) = child.try_wait().expect("poll the root") {
				return status;
			}
			if std::time::Instant::now() >= deadline {
				let _ = child.kill();
				return child.wait().expect("reap the killed root");
			}
			std::thread::sleep(std::time::Duration::from_millis(1));
		}
	}

	/// A process stopped while it blocks the polite signal runs on once
	/// resumed, until it unblocks the signal, and can fork on the way: dash
	/// blocks every signal around each vfork. A child forked there was read
	/// by no walk, and outlived the termination once its parent died of the
	/// signal. This root blocks the signal and forks only once a step has
	/// continued it, so only a walk that steps it reads that child. Where no
	/// masks are shown (gVisor) the walk steps nothing, and this is a stated
	/// limit.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_steps_a_process_that_blocks_the_signal() {
		if !masks_shown() {
			eprintln!("no signal masks shown here: the walk steps no process");
			return;
		}
		let (root, pipe) = spawn_term_blocker(BeforeFork::Continued, true);
		let _guard = GroupGuard(root);
		let process = Process::from_pid(root).expect("pin the root");
		let exited = process
			.terminate_tree(false, 1000, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let outlived = reap_term_blocker(root, &pipe);
		assert!(exited, "the root must be gone");
		assert!(!outlived, "the child forked while the signal was blocked outlived the termination");
	}

	/// A process that blocks the signal and sleeps 50 ms before it forks is
	/// stepped through its sleep, within the 100 ms each process may be
	/// stepped, so the child it then forks is read with it.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_steps_a_process_through_a_sleep_before_its_fork() {
		if !masks_shown() {
			eprintln!("no signal masks shown here: the walk steps no process");
			return;
		}
		let (root, pipe) = spawn_term_blocker(BeforeFork::Sleep(50), true);
		let _guard = GroupGuard(root);
		let process = Process::from_pid(root).expect("pin the root");
		let exited = process
			.terminate_tree(false, 1000, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let outlived = reap_term_blocker(root, &pipe);
		assert!(exited, "the root must be gone");
		assert!(
			!outlived,
			"the child forked after a 50 ms sleep with the signal blocked outlived the termination"
		);
	}

	/// A TERM handler that forks while its process keeps running: the hard
	/// wave stops and reads the tree again, so its KILL reaches that child.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_kills_a_child_a_term_handler_forks() {
		use std::{
			io::{BufRead, BufReader},
			os::unix::process::CommandExt,
			process::{Command, Stdio},
		};

		let mut root = Command::new("/bin/sh")
			.args(["-c", "trap 'sleep 1000 >/dev/null & echo $!' TERM; while :; do sleep 0.01; done"])
			.stdout(Stdio::piped())
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		wait_until("the root runs its loop", || !process.children().unwrap_or_default().is_empty());

		let exited = process
			.terminate_tree(false, 300, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap(&mut root);
		let mut line = String::new();
		BufReader::new(root.stdout.take().expect("root stdout"))
			.read_line(&mut line)
			.expect("read the handler's child");
		let child = Process::from_pid(line.trim().parse().expect("the handler forked its child"));
		let outlived = child
			.as_ref()
			.is_some_and(|child| child.status() == ProcessStatus::Running);
		if let Some(child) = &child {
			let _ = child.signal(KILL_SIGNAL);
		}
		assert!(exited, "the tree must be gone");
		assert!(!outlived, "the child the TERM handler forked outlived the termination");
	}

	/// A process that blocks TERM for good, as one that reads it through a
	/// signalfd does, and forks once a TERM is pending: its stepping ends at
	/// the step limit, the TERM stays pending, and the hard wave stops and
	/// reads the tree again, so its KILL reaches the child.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_kills_a_child_forked_by_a_process_that_blocks_term() {
		let (root, pipe) = spawn_term_blocker(BeforeFork::TermPending, false);
		let _guard = GroupGuard(root);
		let process = Process::from_pid(root).expect("pin the root");
		let exited = process
			.terminate_tree(false, 300, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let outlived = reap_term_blocker(root, &pipe);
		assert!(exited, "the tree must be gone");
		assert!(!outlived, "the child forked once the TERM was pending outlived the termination");
	}

	/// A child the root forks after a wave has read the tree, but before the
	/// root is signalled, outlived the termination: the root died of the
	/// signal, the child moved to init, and no later walk could reach it. The
	/// hook asks the root to fork in exactly that gap, then waits until it has
	/// forked or reads stopped; no such child may be left running.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_leaves_no_child_forked_after_the_walk() {
		use std::{
			io::Write,
			os::unix::process::CommandExt,
			process::{Command, Stdio},
			sync::{Arc, Mutex},
		};

		// The root forks a long-lived child only once it reads a line.
		let mut root = Command::new("/bin/sh")
			.args(["-c", "read line; sleep 1000 & wait"])
			.stdin(Stdio::piped())
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let process = Process::from_pid(root_pid).expect("pin the root");
		let _guard = GroupGuard(root_pid);
		let mut stdin = root.stdin.take().expect("root stdin");
		let forked = Arc::new(Mutex::new(None::<Process>));
		{
			let forked = Arc::clone(&forked);
			let watched = process.clone();
			wave_hook::set(
				root_pid,
				Box::new(move || {
					stdin.write_all(b"\n").expect("ask the root to fork");
					// The root either forks, as it still runs, or reads stopped.
					let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
					while std::time::Instant::now() < deadline {
						if let Some(child) = watched.children().unwrap_or_default().into_iter().next() {
							*forked.lock().expect("forked child") = Some(child);
							return;
						}
						if thread_state(root_pid) == Some('T') {
							return;
						}
						std::thread::yield_now();
					}
				}),
			);
		}

		let exited = process
			.terminate_tree(false, 1000, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap(&mut root);
		let child = forked.lock().expect("forked child").take();
		let outlived = child
			.as_ref()
			.is_some_and(|child| child.status() == ProcessStatus::Running);
		if let Some(child) = &child {
			let _ = child.signal(KILL_SIGNAL);
		}
		assert!(exited, "the root must be gone");
		assert!(!outlived, "the child the root forked after the walk outlived the termination");
	}

	/// A wave resumes the processes it stopped, so one that handles the signal
	/// runs its handler at once, instead of waiting stopped for the hard
	/// wave's kill.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_resumes_the_processes_it_stopped() {
		use std::{
			os::unix::process::{CommandExt, ExitStatusExt},
			process::Command,
		};

		// `wait` returns as soon as a trapped signal arrives, so the trap runs
		// once the shell may run at all.
		let mut root = Command::new("/bin/sh")
			.args(["-c", "trap 'exit 7' TERM; sleep 1000 & wait"])
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		wait_until("the root forked its sleep", || {
			!process.children().unwrap_or_default().is_empty()
		});

		// The grace period only bounds a failure: the trap ends the root at once.
		let exited = process
			.terminate_tree(false, 30_000, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let status = reap(&mut root);
		assert!(exited, "the tree must be gone");
		assert_eq!(
			(status.code(), status.signal()),
			(Some(7), None),
			"the root must run its TERM trap, not die of the hard wave's kill",
		);
	}

	/// Kills the pinned processes on drop, so a failing test leaves none of
	/// them running.
	#[cfg(target_os = "linux")]
	struct KillOnDrop(Vec<Process>);

	#[cfg(target_os = "linux")]
	impl Drop for KillOnDrop {
		fn drop(&mut self) {
			for process in &self.0 {
				let _ = process.signal(KILL_SIGNAL);
			}
		}
	}

	/// The command name of `pid` (`/proc/<pid>/comm`), empty when unreadable.
	#[cfg(target_os = "linux")]
	fn comm(pid: i32) -> String {
		std::fs::read(format!("/proc/{pid}/comm"))
			.map_or_else(|_| String::new(), |name| String::from_utf8_lossy(&name).trim().to_string())
	}

	/// The live (not zombie) processes of process group `pgid`, after giving
	/// killed ones up to 2 s to be reaped by whoever adopted them.
	#[cfg(target_os = "linux")]
	fn live_group_members(pgid: i32) -> Vec<i32> {
		let read = || -> Vec<i32> {
			std::fs::read_dir("/proc")
				.into_iter()
				.flatten()
				.flatten()
				.filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
				.filter(|pid| {
					let Ok(stat) = std::fs::read(format!("/proc/{pid}/stat")) else {
						return false;
					};
					let stat = String::from_utf8_lossy(&stat);
					let Some(end) = stat.rfind(')') else {
						return false;
					};
					let fields: Vec<&str> = stat[end + 1..].split_whitespace().collect();
					fields.get(2).and_then(|group| group.parse().ok()) == Some(pgid)
						&& !matches!(fields.first(), Some(&("Z" | "X")))
				})
				.collect()
		};
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
		loop {
			let left = read();
			if left.is_empty() || std::time::Instant::now() >= deadline {
				return left;
			}
			std::thread::sleep(std::time::Duration::from_millis(10));
		}
	}

	/// The walk stops no process of the caller's own process group: on gVisor
	/// before google/gvisor 553528ee a stopped member brings SIGHUP to every
	/// member, the caller included, as another member is reaped. The hook
	/// looks at the tree between the walk and the signal.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_stops_no_process_of_the_callers_group() {
		use std::{
			process::Command,
			sync::{Arc, Mutex},
		};

		let mut root = Command::new("/bin/sh")
			.args(["-c", "sleep 1000 & wait"])
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let process = Process::from_pid(root_pid).expect("pin the root");
		wait_until("the root forked its sleep", || {
			!process.children().unwrap_or_default().is_empty()
		});
		let child = process.children().unwrap_or_default().remove(0);
		let _guard = KillOnDrop(vec![process.clone(), child.clone()]);
		let child_pid = child.pid();
		let states = Arc::new(Mutex::new(Vec::new()));
		{
			let states = Arc::clone(&states);
			wave_hook::set(
				root_pid,
				Box::new(move || {
					states
						.lock()
						.expect("states")
						.extend([thread_state(root_pid), thread_state(child_pid)]);
				}),
			);
		}

		let exited = process
			.terminate_tree(false, 1000, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap(&mut root);
		let states = states.lock().expect("states").clone();
		assert!(exited, "the tree must be gone");
		assert!(!states.is_empty(), "the wave ran its hook");
		assert!(
			!states.contains(&Some('T')),
			"a process of the caller's group was stopped: {states:?}"
		);
	}

	/// Each level of the walk waits until the processes it stopped have
	/// stopped before it reads their children: one still running when its
	/// children are read could fork once more. A root that spins in user
	/// space, in a process group of its own, reads stopped when the wave's
	/// signal goes out.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_waits_until_the_tree_has_stopped() {
		use std::{
			os::unix::process::CommandExt,
			process::Command,
			sync::{Arc, Mutex},
		};

		for run in 0..20 {
			let mut root = Command::new("/bin/sh")
				.args(["-c", "while :; do :; done"])
				.process_group(0)
				.spawn()
				.expect("spawn the root");
			let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
			let _guard = GroupGuard(root_pid);
			let process = Process::from_pid(root_pid).expect("pin the root");
			let state = Arc::new(Mutex::new(None));
			{
				let state = Arc::clone(&state);
				wave_hook::set(
					root_pid,
					Box::new(move || *state.lock().expect("state") = thread_state(root_pid)),
				);
			}
			let exited = process
				.terminate_tree(false, 1000, 5000, CancelToken::default())
				.await
				.expect("terminate");
			let _ = reap(&mut root);
			let state = *state.lock().expect("state");
			assert!(exited, "run {run}: the root must be gone");
			assert_eq!(state, Some('T'), "run {run}: the root was read before it had stopped");
		}
	}

	/// A call whose cancellation has already fired still sends the polite
	/// wave, and leaves nothing stopped: the tree ends of the TERM.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_sends_the_polite_wave_when_already_cancelled() {
		use std::{os::unix::process::CommandExt, process::Command};

		let mut root = Command::new("/bin/sh")
			.args(["-c", "sleep 1000 & wait"])
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		wait_until("the root forked its sleep", || {
			!process.children().unwrap_or_default().is_empty()
		});
		let child = process.children().unwrap_or_default().remove(0);

		let cancelled = CancelToken::with_timeout(Some(Duration::ZERO));
		let result = process.terminate_tree(false, 1000, 5000, cancelled).await;
		let _ = reap(&mut root);
		wait_until("the sleep ends of the TERM", || child.status() != ProcessStatus::Running);
		assert!(result.is_err(), "the cancelled call reports its cancellation");
	}

	/// The hard wave signals every process the polite wave signalled that
	/// still runs. A child that ignores TERM outlives its parent's TERM and
	/// moves to init, where no walk from the root reaches it.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_kills_a_term_ignoring_child_its_parent_left() {
		use std::{os::unix::process::CommandExt, process::Command};

		let mut root = Command::new("/bin/sh")
			.args(["-c", "(trap '' TERM; exec sleep 1000) & wait"])
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		// It has set its trap once it runs sleep.
		wait_until("the child runs sleep", || {
			process
				.children()
				.unwrap_or_default()
				.first()
				.is_some_and(|child| comm(child.pid()) == "sleep")
		});
		let child = process.children().unwrap_or_default().remove(0);

		let exited = process
			.terminate_tree(false, 200, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap(&mut root);
		let outlived = child.status() == ProcessStatus::Running;
		assert!(exited, "the tree must be gone");
		assert!(!outlived, "the TERM-ignoring child outlived the termination once its parent died");
	}

	/// A child that was stopped before the walk, and ignores TERM, is neither
	/// resumed by the walk nor left running: the hard wave kills it.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_kills_a_stopped_child_its_parent_left() {
		use std::{os::unix::process::CommandExt, process::Command};

		// The subshell ignores TERM and becomes a shell that stops itself
		// (an ignored signal stays ignored across exec); continued, it would
		// run sleep with TERM still ignored.
		let mut root = Command::new("/bin/sh")
			.args(["-c", "(trap '' TERM; exec sh -c 'kill -STOP $$; exec sleep 1000') & wait"])
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		wait_until("the child stopped itself", || {
			process
				.children()
				.unwrap_or_default()
				.first()
				.is_some_and(|child| thread_state(child.pid()) == Some('T'))
		});
		let child = process.children().unwrap_or_default().remove(0);

		let exited = process
			.terminate_tree(false, 200, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap(&mut root);
		let outlived = child.status() == ProcessStatus::Running;
		assert!(exited, "the tree must be gone");
		assert!(!outlived, "the stopped child outlived the termination once its parent died");
	}

	/// The processes of process group `pgid` and their command names, read
	/// once.
	#[cfg(target_os = "linux")]
	fn group_members_now(pgid: i32) -> Vec<(i32, String)> {
		std::fs::read_dir("/proc")
			.into_iter()
			.flatten()
			.flatten()
			.filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
			// SAFETY: getpgid takes a scalar; a pid that ended reads -1.
			.filter(|pid| unsafe { libc::getpgid(*pid) } == pgid)
			.map(|pid| (pid, comm(pid)))
			.collect()
	}

	/// In group mode, a process of the group that left the tree before the
	/// walk (its parent exited, so it moved to init) and ignores TERM is
	/// ended through the group: the grace wait lasts while the group holds a
	/// live member, and the hard wave's group KILL reaches it.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_in_group_mode_ends_a_member_that_left_the_tree() {
		use std::{os::unix::process::CommandExt, process::Command};

		// The subshell forks a TERM-ignoring sleep and exits, so the sleep
		// moves to init, out of the tree but still in the root's group; the
		// root then runs a plain sleep, which dies of the polite wave's TERM.
		let mut root = Command::new("/bin/sh")
			.args(["-c", "( (trap '' TERM; exec sleep 1000) & ); exec sleep 1000"])
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		let mut member = 0;
		// The member runs sleep once its trap is set, and has left the tree
		// once the root has no child.
		wait_until("a TERM-ignoring member left the tree", || {
			let others: Vec<(i32, String)> = group_members_now(root_pid)
				.into_iter()
				.filter(|(pid, _)| *pid != root_pid)
				.collect();
			if comm(root_pid) == "sleep"
				&& process.children().unwrap_or_default().is_empty()
				&& let [(pid, name)] = &others[..]
				&& name == "sleep"
			{
				member = *pid;
				return true;
			}
			false
		});
		let member = Process::from_pid(member).expect("pin the member");

		let exited = process
			.terminate_tree(true, 200, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap(&mut root);
		let outlived = member.status() == ProcessStatus::Running;
		assert!(exited, "the group must be gone");
		assert!(!outlived, "the member that left the tree outlived the termination");
	}

	/// In group mode, the hard wave's wait sends the group its KILL again
	/// while a member is left. The helper joins the group right after the
	/// hard wave's KILL, as a stand-in for a process that signal missed as it
	/// was forked (seen under gVisor; Linux does not let a group signal miss
	/// a concurrent fork).
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_in_group_mode_ends_a_member_that_joins_after_the_kill() {
		use std::{os::unix::process::CommandExt, process::Command};

		// The root ignores TERM, so the polite wave leaves it running and the
		// hard wave's KILL ends it.
		let mut root = Command::new("/bin/sh")
			.args(["-c", "trap '' TERM; exec sleep 1000"])
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		wait_until("the root runs sleep with TERM ignored", || comm(root_pid) == "sleep");
		// SAFETY: the child only calls pause, which is async-signal-safe; the
		// test process has other threads.
		let helper = unsafe { libc::fork() };
		assert!(helper >= 0, "fork the helper");
		if helper == 0 {
			loop {
				// SAFETY: pause takes no arguments.
				unsafe { libc::pause() };
			}
		}
		let joined = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
		{
			let joined = std::sync::Arc::clone(&joined);
			wave_hook::set_after(
				root_pid,
				KILL_SIGNAL,
				Box::new(move || {
					// SAFETY: setpgid takes scalars; the helper is this process's
					// child, has not exec'd, and the group is in this session.
					let ok = unsafe { libc::setpgid(helper, root_pid) } == 0;
					joined.store(ok, std::sync::atomic::Ordering::SeqCst);
				}),
			);
		}

		let exited = process
			.terminate_tree(true, 100, 3000, CancelToken::default())
			.await
			.expect("terminate");
		let mut status = 0;
		// SAFETY: `status` is a valid out-pointer; WNOHANG returns at once.
		let reaped = unsafe { libc::waitpid(helper, &raw mut status, libc::WNOHANG) } == helper;
		if !reaped {
			// SAFETY: kill and waitpid take scalars and a valid out-pointer.
			unsafe {
				libc::kill(helper, libc::SIGKILL);
				libc::waitpid(helper, &raw mut status, 0);
			}
		}
		let _ = reap(&mut root);
		assert!(
			joined.load(std::sync::atomic::Ordering::SeqCst),
			"the helper joined the group after the KILL"
		);
		assert!(exited, "the group must be gone");
		assert!(
			reaped && libc::WIFSIGNALED(status) && libc::WTERMSIG(status) == libc::SIGKILL,
			"the member that joined after the group KILL outlived the termination",
		);
	}

	/// In group mode, a loop that forks as fast as it can leaves no process of
	/// its group running once terminated: the walk holds the tree, and both
	/// waits last until the group is empty. Several runs, as one run can miss
	/// a window.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_in_group_mode_leaves_no_child_of_a_forking_loop() {
		use std::{os::unix::process::CommandExt, process::Command};

		for run in 0..5 {
			let mut root = Command::new("/bin/sh")
				.args(["-c", "while :; do sleep 1000 & done"])
				.process_group(0)
				.spawn()
				.expect("spawn the root");
			let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
			let _guard = GroupGuard(root_pid);
			let process = Process::from_pid(root_pid).expect("pin the root");
			wait_until("the loop forked", || process.children().unwrap_or_default().len() >= 3);
			let exited = process
				.terminate_tree(true, 1000, 5000, CancelToken::default())
				.await
				.expect("terminate");
			let _ = reap(&mut root);
			let left = live_group_members(root_pid);
			assert!(exited, "run {run}: the group must be gone");
			assert!(
				left.is_empty(),
				"run {run}: processes of the loop's group outlived the termination: {left:?}"
			);
		}
	}

	/// Waits, up to 10 s, for this process's child `pid` to end and reaps
	/// it; kills it first if it has not ended by then. Returns its wait
	/// status.
	#[cfg(target_os = "linux")]
	fn reap_pid(pid: i32) -> libc::c_int {
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
		let mut status = 0;
		loop {
			// SAFETY: `status` is a valid out-pointer; WNOHANG returns at once.
			let got = unsafe { libc::waitpid(pid, &raw mut status, libc::WNOHANG) };
			if got != 0 {
				return status;
			}
			if std::time::Instant::now() >= deadline {
				// SAFETY: kill and waitpid take scalars and a valid out-pointer.
				unsafe {
					libc::kill(pid, libc::SIGKILL);
					libc::waitpid(pid, &raw mut status, 0);
				}
				return status;
			}
			std::thread::sleep(std::time::Duration::from_millis(1));
		}
	}

	/// In group mode, a group whose members cannot be read (the listing of
	/// `/proc` fails, as it does out of descriptors) counts as alive: the
	/// grace wait does not end early, and the hard wave's KILL reaches a
	/// TERM-ignoring member that left the tree.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_in_group_mode_kills_when_the_group_cannot_be_read() {
		use std::{os::unix::process::CommandExt, process::Command};

		let mut root = Command::new("/bin/sh")
			.args(["-c", "( (trap '' TERM; exec sleep 1000) & ); exec sleep 1000"])
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		let mut member = 0;
		wait_until("a TERM-ignoring member left the tree", || {
			let others: Vec<(i32, String)> = group_members_now(root_pid)
				.into_iter()
				.filter(|(pid, _)| *pid != root_pid)
				.collect();
			if comm(root_pid) == "sleep"
				&& process.children().unwrap_or_default().is_empty()
				&& let [(pid, name)] = &others[..]
				&& name == "sleep"
			{
				member = *pid;
				return true;
			}
			false
		});
		let member = Process::from_pid(member).expect("pin the member");

		proc_read_fault::set(root_pid);
		let _ = process
			.terminate_tree(true, 200, 2000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap(&mut root);
		let outlived = member.status() == ProcessStatus::Running;
		assert!(
			!outlived,
			"the member outlived the termination: an unreadable group was read as empty"
		);
	}

	/// Without a grace period the polite wave steps no process: the signal
	/// has no time to act before the KILL. With one, the same root is
	/// stepped (the control).
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_steps_no_process_without_a_grace_period() {
		if !masks_shown() {
			eprintln!("no signal masks shown here: the walk steps no process");
			return;
		}
		let (root, _pipe) = spawn_term_blocker(BeforeFork::TermPending, false);
		let _guard = GroupGuard(root);
		let process = Process::from_pid(root).expect("pin the root");
		let _ = process
			.terminate_tree(false, -1, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap_pid(root);
		assert_eq!(wave_hook::steps(root), 0, "a call with no grace period stepped a process");

		let (control, _pipe) = spawn_term_blocker(BeforeFork::TermPending, false);
		let _guard = GroupGuard(control);
		let process = Process::from_pid(control).expect("pin the control");
		let _ = process
			.terminate_tree(false, 100, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap_pid(control);
		assert!(wave_hook::steps(control) > 0, "the control with a grace period was not stepped");
	}

	/// The hard wave walks the tree under each survivor of the polite wave:
	/// a subshell that ignores TERM outlives its parent, moves to init, and
	/// forks during the grace period; what it forked is ended with it.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_kills_what_a_survivor_forks_in_the_grace_period() {
		use std::{os::unix::process::CommandExt, process::Command};

		let mut root = Command::new("/bin/sh")
			.args(["-c", "(trap '' TERM; while :; do sleep 1000 & sleep 0.05; done) & wait"])
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		wait_until("the subshell forked", || {
			process
				.children()
				.unwrap_or_default()
				.first()
				.is_some_and(|subshell| subshell.children().unwrap_or_default().len() >= 2)
		});

		let exited = process
			.terminate_tree(false, 300, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap(&mut root);
		let left = live_group_members(root_pid);
		assert!(exited, "the tree must be gone");
		assert!(
			left.is_empty(),
			"what the survivor forked in the grace period outlived the termination: {left:?}"
		);
	}

	/// A process that was stopped before the walk is left stopped: the polite
	/// TERM stays pending, and the hard wave's KILL ends it. A walk that
	/// resumed it would let it die of the TERM.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_leaves_a_process_stopped_before_the_walk_stopped() {
		use std::{
			os::unix::process::{CommandExt, ExitStatusExt},
			process::Command,
		};

		let mut root = Command::new("sleep")
			.arg("1000")
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		// SAFETY: kill takes scalars; the root is this process's child.
		unsafe { libc::kill(root_pid, libc::SIGSTOP) };
		wait_until("the root stopped", || thread_state(root_pid) == Some('T'));

		let exited = process
			.terminate_tree(false, 200, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let status = reap(&mut root);
		assert!(exited, "the root must be gone");
		assert_eq!(
			status.signal(),
			Some(libc::SIGKILL),
			"the stopped root was resumed and died of the TERM"
		);
	}

	/// Forks a root, in a process group of its own, whose one thread waits in
	/// vfork until the first returned pipe gets a byte or is closed: a stop
	/// sent to the root takes only once its vfork child has ended (the vfork
	/// wait ends only for that, or for a fatal signal). Once released, the
	/// vfork child, which blocks TERM, makes the root a new child (clone with
	/// `CLONE_PARENT`) that runs `/bin/sleep 1000`, writes that child's pid to
	/// the second pipe, and ends. Returns once the vfork child runs. Only raw
	/// system calls run after the forks: the test process has other threads.
	#[cfg(target_os = "linux")]
	fn spawn_vfork_holder() -> (i32, std::os::fd::OwnedFd, std::os::fd::OwnedFd) {
		use std::{ffi::CStr, os::fd::FromRawFd, ptr};

		const SLEEP: &CStr = c"/bin/sleep";
		let argv = [SLEEP.as_ptr(), c"1000".as_ptr(), ptr::null()];
		let mut release = [0; 2];
		let mut made = [0; 2];
		let mut ready = [0; 2];
		// SAFETY: each array has room for the two descriptors pipe2 writes.
		unsafe {
			assert_eq!(libc::pipe2(release.as_mut_ptr(), libc::O_CLOEXEC), 0, "release pipe");
			assert_eq!(libc::pipe2(made.as_mut_ptr(), libc::O_CLOEXEC), 0, "pid pipe");
			assert_eq!(libc::pipe2(ready.as_mut_ptr(), libc::O_CLOEXEC), 0, "ready pipe");
		}
		// SAFETY: the child runs only raw system calls on memory made before the
		// fork, and leaves by `_exit`, `execv` or never.
		let root = unsafe { libc::fork() };
		assert!(root >= 0, "fork the root");
		if root == 0 {
			// SAFETY: as above. The vfork child shares this memory and stack: it
			// calls only system call wrappers and leaves by `_exit`.
			unsafe {
				libc::setpgid(0, 0);
				libc::signal(libc::SIGTERM, libc::SIG_DFL);
				let mut none: libc::sigset_t = std::mem::zeroed();
				libc::sigemptyset(&raw mut none);
				libc::sigprocmask(libc::SIG_SETMASK, &raw const none, ptr::null_mut());
				libc::close(release[1]);
				libc::close(made[0]);
				libc::close(ready[0]);
				#[allow(
					deprecated,
					reason = "the libc crate marks vfork deprecated; this test needs its wait"
				)]
				let holder = libc::vfork();
				if holder == 0 {
					let mut term: libc::sigset_t = std::mem::zeroed();
					libc::sigemptyset(&raw mut term);
					libc::sigaddset(&raw mut term, libc::SIGTERM);
					libc::sigprocmask(libc::SIG_BLOCK, &raw const term, ptr::null_mut());
					libc::write(ready[1], [1u8].as_ptr().cast(), 1);
					let mut byte = 0u8;
					if libc::read(release[0], (&raw mut byte).cast(), 1) != 1 {
						libc::_exit(1);
					}
					let flags = libc::c_long::from(libc::CLONE_PARENT | libc::SIGCHLD);
					let child = libc::syscall(libc::SYS_clone, flags, 0, 0, 0, 0);
					if child == 0 {
						libc::sigprocmask(libc::SIG_SETMASK, &raw const none, ptr::null_mut());
						libc::execv(SLEEP.as_ptr(), argv.as_ptr());
						libc::_exit(127);
					}
					let pid = libc::pid_t::try_from(child).unwrap_or(0);
					libc::write(made[1], (&raw const pid).cast(), size_of::<libc::pid_t>());
					libc::_exit(0);
				}
				loop {
					libc::pause();
				}
			}
		}
		// Also from here, so the group exists before the test reads it.
		// SAFETY: setpgid takes scalars; the root is this process's child.
		unsafe { libc::setpgid(root, root) };
		let mut byte = 0u8;
		// SAFETY: the ends are this process's own descriptors, each closed once
		// or owned from here; `byte` has room for the one byte read. The read
		// returns at the vfork child's write, or at 0 if it ended first.
		let got = unsafe {
			libc::close(release[0]);
			libc::close(made[1]);
			libc::close(ready[1]);
			let got = libc::read(ready[0], (&raw mut byte).cast(), 1);
			libc::close(ready[0]);
			got
		};
		assert_eq!(got, 1, "the vfork child runs");
		// SAFETY: the release write end and the pid read end are this process's
		// own descriptors, owned from here.
		unsafe {
			(
				root,
				std::os::fd::OwnedFd::from_raw_fd(release[1]),
				std::os::fd::OwnedFd::from_raw_fd(made[0]),
			)
		}
	}

	/// The walk waits until a process it stopped has stopped before it reads
	/// its children: a child the process makes between the SIGSTOP and its
	/// stop is read too. This root is held in vfork, so its stop takes only
	/// once its vfork child has ended; 40 ms after the wave's SIGSTOP the
	/// child is let go, makes the root a new child, and ends. A walk that read
	/// the root's children at once would miss that child, and the root, dying
	/// of the TERM, would leave it running under init.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_reads_a_child_made_before_the_stop_takes() {
		use std::os::fd::AsRawFd;

		let (root, release, made) = spawn_vfork_holder();
		let _guard = GroupGuard(root);
		let process = Process::from_pid(root).expect("pin the root");
		wave_hook::set_stop_sent(
			root,
			Box::new(move || {
				std::thread::spawn(move || {
					std::thread::sleep(Duration::from_millis(40));
					// SAFETY: the descriptor is the release pipe's write end,
					// owned by this closure; the buffer holds the one byte.
					unsafe { libc::write(release.as_raw_fd(), [1u8].as_ptr().cast(), 1) };
				});
			}),
		);

		let exited = process
			.terminate_tree(false, 1000, 5000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap_pid(root);
		let mut child: libc::pid_t = 0;
		// SAFETY: the descriptor is the pid pipe's read end; `child` has room
		// for the pid read. It returns 0 if the vfork child ended first.
		let got =
			unsafe { libc::read(made.as_raw_fd(), (&raw mut child).cast(), size_of::<libc::pid_t>()) };
		let left = live_group_members(root);
		assert_eq!(
			usize::try_from(got).ok(),
			Some(size_of::<libc::pid_t>()),
			"the vfork child made the root a child"
		);
		assert!(exited, "the root must be gone");
		assert!(
			left.is_empty(),
			"the child {child} the root made before its stop took outlived the termination: {left:?}"
		);
	}

	/// In group mode, a group whose member's stat file cannot be read (out of
	/// descriptors, say) counts as alive, though `/proc` itself lists: the
	/// grace wait does not end early, and the hard wave's KILL reaches the
	/// TERM-ignoring member that left the tree.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_in_group_mode_kills_when_a_member_cannot_be_read() {
		use std::{os::unix::process::CommandExt, process::Command};

		let mut root = Command::new("/bin/sh")
			.args(["-c", "( (trap '' TERM; exec sleep 1000) & ); exec sleep 1000"])
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");
		let mut member = 0;
		wait_until("a TERM-ignoring member left the tree", || {
			let others: Vec<(i32, String)> = group_members_now(root_pid)
				.into_iter()
				.filter(|(pid, _)| *pid != root_pid)
				.collect();
			if comm(root_pid) == "sleep"
				&& process.children().unwrap_or_default().is_empty()
				&& let [(pid, name)] = &others[..]
				&& name == "sleep"
			{
				member = *pid;
				return true;
			}
			false
		});
		proc_read_fault::set_stat(member);
		let member = Process::from_pid(member).expect("pin the member");

		let _ = process
			.terminate_tree(true, 200, 2000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap(&mut root);
		let outlived = member.status() == ProcessStatus::Running;
		assert!(
			!outlived,
			"the member outlived the termination: a group whose member could not be read was read as \
			 empty"
		);
	}

	/// A name that is not UTF-8, as a name the kernel cut inside a multibyte
	/// character is.
	#[cfg(target_os = "linux")]
	const NON_UTF8_NAME: &[u8] = b"\xe8x\0";

	/// Forks a process that, in a process group of its own when `own_group`,
	/// blocks or ignores TERM as `term` says, names itself [`NON_UTF8_NAME`]
	/// and pauses for good. Returns once it has its name. Only raw system calls
	/// run after the fork: the test process has other threads.
	#[cfg(target_os = "linux")]
	fn spawn_non_utf8_named(own_group: bool, term: NonUtf8Term) -> i32 {
		use std::ptr;

		let mut ready = [0; 2];
		// SAFETY: the array has room for the two descriptors pipe2 writes.
		assert_eq!(unsafe { libc::pipe2(ready.as_mut_ptr(), libc::O_CLOEXEC) }, 0, "ready pipe");
		// SAFETY: the child runs only raw system calls on memory made before the
		// fork, and leaves by being killed.
		let pid = unsafe { libc::fork() };
		assert!(pid >= 0, "fork");
		if pid == 0 {
			// SAFETY: as above; every pointer names a live local of this frame.
			unsafe {
				if own_group {
					libc::setpgid(0, 0);
				}
				match term {
					NonUtf8Term::Default => {
						libc::signal(libc::SIGTERM, libc::SIG_DFL);
					},
					NonUtf8Term::Ignored => {
						libc::signal(libc::SIGTERM, libc::SIG_IGN);
					},
					NonUtf8Term::Blocked => {
						libc::signal(libc::SIGTERM, libc::SIG_DFL);
						let mut set: libc::sigset_t = std::mem::zeroed();
						libc::sigemptyset(&raw mut set);
						libc::sigaddset(&raw mut set, libc::SIGTERM);
						libc::sigprocmask(libc::SIG_BLOCK, &raw const set, ptr::null_mut());
					},
				}
				libc::prctl(libc::PR_SET_NAME, NON_UTF8_NAME.as_ptr());
				libc::write(ready[1], [1u8].as_ptr().cast(), 1);
				loop {
					libc::pause();
				}
			}
		}
		if own_group {
			// SAFETY: setpgid takes scalars; the child is this process's own.
			unsafe { libc::setpgid(pid, pid) };
		}
		let mut byte = 0u8;
		// SAFETY: the ends are this process's own descriptors, each closed once;
		// `byte` has room for the one byte read.
		let got = unsafe {
			libc::close(ready[1]);
			let got = libc::read(ready[0], (&raw mut byte).cast(), 1);
			libc::close(ready[0]);
			got
		};
		assert_eq!(got, 1, "the child named itself");
		pid
	}

	/// What a [`spawn_non_utf8_named`] process does with TERM.
	#[cfg(target_os = "linux")]
	#[derive(Clone, Copy)]
	enum NonUtf8Term {
		Default,
		Ignored,
		Blocked,
	}

	/// Kills and reaps this process's child `pid` on drop.
	#[cfg(target_os = "linux")]
	struct ChildGuard(i32);

	#[cfg(target_os = "linux")]
	impl Drop for ChildGuard {
		fn drop(&mut self) {
			let mut status = 0;
			// SAFETY: kill and waitpid take scalars and a valid out-pointer; the
			// pid is this process's own child, not yet reaped.
			unsafe {
				libc::kill(self.0, libc::SIGKILL);
				libc::waitpid(self.0, &raw mut status, 0);
			}
		}
	}

	/// Whether `pid` has a stat whose state is not `Z` or `X`, read as bytes.
	#[cfg(target_os = "linux")]
	fn alive(pid: i32) -> bool {
		thread_state(pid).is_some_and(|state| state != 'Z' && state != 'X')
	}

	/// In group mode, a process anywhere on the machine whose name is not
	/// UTF-8 no longer makes the group wait read every group as alive: the
	/// group of an ended root, its zombie not yet reaped, is read as empty, and
	/// the call returns `true` well before its bound. The process is outside
	/// the group.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_in_group_mode_ends_with_a_non_utf8_named_process_running() {
		use std::{os::unix::process::CommandExt, process::Command};

		let named = spawn_non_utf8_named(false, NonUtf8Term::Default);
		let _named = ChildGuard(named);
		let mut root = Command::new("sleep")
			.arg("1000")
			.process_group(0)
			.spawn()
			.expect("spawn the root");
		let root_pid = i32::try_from(root.id()).expect("root pid fits in i32");
		let _guard = GroupGuard(root_pid);
		let process = Process::from_pid(root_pid).expect("pin the root");

		let started = std::time::Instant::now();
		let exited = process
			.terminate_tree(true, 100, 3000, CancelToken::default())
			.await
			.expect("terminate");
		let took = started.elapsed();
		let _ = reap(&mut root);
		assert!(exited, "group-mode terminate read the ended root's group as alive (took {took:?})");
		assert!(took < Duration::from_millis(2000), "the group wait ran to its bound: {took:?}");
	}

	/// The walk reads, and ends, a child whose name is not UTF-8. This one
	/// ignores TERM and outlives its parent's TERM, so only a walk that pinned
	/// it kills it.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_kills_a_non_utf8_named_child() {
		// SAFETY: the child calls only raw system calls (setpgid, the helper's
		// fork and its calls, pause) and is killed or ends of a signal.
		let root = unsafe { libc::fork() };
		assert!(root >= 0, "fork the root");
		if root == 0 {
			// SAFETY: as above.
			unsafe {
				libc::setpgid(0, 0);
				libc::signal(libc::SIGTERM, libc::SIG_DFL);
				let _ = spawn_non_utf8_named(false, NonUtf8Term::Ignored);
				loop {
					libc::pause();
				}
			}
		}
		// SAFETY: setpgid takes scalars; the root is this process's child.
		unsafe { libc::setpgid(root, root) };
		let _guard = GroupGuard(root);
		let mut child = 0;
		wait_until("the root's child named itself", || {
			let Ok(children) = std::fs::read(format!("/proc/{root}/task/{root}/children")) else {
				return false;
			};
			let Some(pid) = String::from_utf8_lossy(&children)
				.split_whitespace()
				.find_map(|pid| pid.parse::<i32>().ok())
			else {
				return false;
			};
			let named = std::fs::read(format!("/proc/{pid}/comm"))
				.is_ok_and(|name| name.strip_suffix(b"\n") == Some(&NON_UTF8_NAME[..2]));
			if named {
				child = pid;
			}
			named
		});
		let process = Process::from_pid(root).expect("pin the root");

		let exited = process
			.terminate_tree(false, 200, 3000, CancelToken::default())
			.await
			.expect("terminate");
		let _ = reap_pid(root);
		let deadline = std::time::Instant::now() + Duration::from_secs(2);
		while alive(child) && std::time::Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(5));
		}
		assert!(exited, "the root must be gone");
		assert!(!alive(child), "the child named {NON_UTF8_NAME:?} outlived the termination");
	}

	/// The walk's reads of a process's threads take a name that is not UTF-8:
	/// a running process does not read as stopped, a stopped one does, and
	/// where masks are shown its blocked TERM reads as blocked.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn the_walk_reads_the_threads_of_a_non_utf8_named_process() {
		let named = spawn_non_utf8_named(true, NonUtf8Term::Blocked);
		let _named = ChildGuard(named);
		let process = Process::from_pid(named).expect("pin the process whose name is not UTF-8");
		wait_until("the process sleeps in pause", || thread_state(named) == Some('S'));
		assert!(
			!process.inner.stopped(),
			"a running process whose name is not UTF-8 read as stopped"
		);
		assert!(process.inner.asleep(), "a process asleep in pause did not read as asleep");
		if masks_shown() {
			assert_eq!(
				process.inner.blocks(TERM_SIGNAL),
				Some(true),
				"its blocked TERM did not read as blocked"
			);
		}
		// SAFETY: kill takes scalars; the process is this process's child.
		unsafe { libc::kill(named, libc::SIGSTOP) };
		wait_until("the process stopped", || thread_state(named) == Some('T'));
		assert!(
			process.inner.stopped(),
			"a stopped process whose name is not UTF-8 did not read as stopped"
		);
	}
}
