//! Cross-platform process tree management.

use std::{
	collections::{HashMap, HashSet},
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
		fs,
		os::fd::{AsFd, AsRawFd, OwnedFd},
		sync::Arc,
	};

	use pi_builtins::proc_sys as sys;

	use super::ProcessStatus;

	/// Stable Linux process reference backed by a pidfd.
	#[derive(Clone)]
	pub struct Process {
		pid:        i32,
		pidfd:      Arc<OwnedFd>,
		start_time: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let pidfd = Arc::new(sys::open_pidfd(pid)?);
			let start_time = sys::start_time(pid)?;
			Some(Self { pid, pidfd, start_time })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			if !self.live_identity() {
				return Vec::new();
			}

			// `/proc/{pid}/task/{tid}/children` is per-task: a child fork()ed from
			// a worker thread appears under that thread's `tid`, not the tgid.
			// Walk every task subdir and union the lists, then re-validate
			// parentage.
			let task_dir = format!("/proc/{}/task", self.pid);
			let Ok(entries) = fs::read_dir(&task_dir) else {
				return Vec::new();
			};

			let mut seen: HashSet<i32> = HashSet::new();
			let mut out = Vec::new();
			let mut children_file_available = false;
			for entry in entries.flatten() {
				let name = entry.file_name();
				let Some(tid_str) = name.to_str() else {
					continue;
				};
				if tid_str.parse::<i32>().is_err() {
					continue;
				}
				let children_path = format!("/proc/{}/task/{}/children", self.pid, tid_str);
				let Ok(content) = fs::read_to_string(&children_path) else {
					continue;
				};
				// The file is readable -> this kernel has CONFIG_PROC_CHILDREN.
				children_file_available = true;
				for part in content.split_whitespace() {
					let Ok(child_pid) = part.parse::<i32>() else {
						continue;
					};
					self.push_validated_child(child_pid, &mut seen, &mut out);
				}
			}

			// Some Kata / microVM guest kernels are built without
			// CONFIG_PROC_CHILDREN, so no `.../children` file exists and the
			// walk above finds nothing — which would silently turn descendant
			// signaling (cancellation cleanup) into a no-op inside such
			// containers. Fall back to scanning `/proc` and grouping
			// by parent pid, the same primitive the macOS path uses. Only taken
			// when no `children` file was readable, so kernels that support it
			// keep the cheap per-task fast path.
			if !children_file_available {
				for child_pid in sys::pids() {
					self.push_validated_child(child_pid, &mut seen, &mut out);
				}
			}
			out
		}

		/// Validate a candidate child pid — dedup, still running, and currently
		/// parented to `self` — then push it onto `out`. Shared by the
		/// `/proc/<pid>/task/<tid>/children` fast path and the `/proc`-scan
		/// fallback for kernels without `CONFIG_PROC_CHILDREN`.
		fn push_validated_child(&self, child_pid: i32, seen: &mut HashSet<i32>, out: &mut Vec<Self>) {
			if child_pid == self.pid || !seen.insert(child_pid) {
				return;
			}
			let Some(child) = Self::from_pid(child_pid) else {
				return;
			};
			if child.status() == ProcessStatus::Running && sys::parent_pid(child.pid) == Some(self.pid)
			{
				out.push(child);
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

		pub fn kill(&self, signal: i32) -> bool {
			sys::pidfd_send_signal(self.pidfd.as_fd(), signal)
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
			loop {
				let mut pollfd =
					libc::pollfd { fd: self.pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
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

		/// Resolves once the process exits: its pidfd becomes readable then.
		pub async fn exited(&self) -> std::io::Result<()> {
			let pidfd = tokio::io::unix::AsyncFd::with_interest(
				self.pidfd.try_clone()?,
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
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			self.descendants_into(&mut out, &mut visited);
			out
		}

		fn descendants_into(&self, out: &mut Vec<Self>, visited: &mut HashSet<i32>) {
			for child in self.children() {
				if visited.insert(child.pid) {
					child.descendants_into(out, visited);
					out.push(child);
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
		ptr,
	};

	use pi_builtins::proc_sys as sys;

	use super::ProcessStatus;

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
			if pid <= 0 {
				return None;
			}
			let info = sys::bsdinfo(pid)?;
			if i32::try_from(info.pbi_pid).ok()? != pid {
				return None;
			}
			Some(Self { pid, start_tvsec: info.pbi_start_tvsec, start_tvusec: info.pbi_start_tvusec })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
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
			let tree = build_process_tree();
			Self::children_from_tree(self.pid, &tree)
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
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			// One process-table snapshot per walk — building it inside the
			// recursion would re-scan every pid for every visited node,
			// producing an `O(N · D)` kernel call pattern. Mirrors the Windows
			// implementation.
			let tree = build_process_tree();
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			Self::collect_descendants_from_tree(self.pid, &tree, &mut visited, &mut out);
			out
		}

		fn children_from_tree(parent: i32, tree: &HashMap<i32, Vec<i32>>) -> Vec<Self> {
			let Some(child_pids) = tree.get(&parent) else {
				return Vec::new();
			};
			child_pids
				.iter()
				.copied()
				.filter_map(Self::from_pid)
				.collect()
		}

		fn collect_descendants_from_tree(
			parent: i32,
			tree: &HashMap<i32, Vec<i32>>,
			visited: &mut HashSet<i32>,
			out: &mut Vec<Self>,
		) {
			let Some(child_pids) = tree.get(&parent) else {
				return;
			};
			for &child_pid in child_pids {
				if !visited.insert(child_pid) {
					continue;
				}
				let Some(child) = Self::from_pid(child_pid) else {
					continue;
				};
				// Post-order: grandchildren first, so leaf processes get signalled
				// before their parents during tree termination.
				Self::collect_descendants_from_tree(child_pid, tree, visited, out);
				out.push(child);
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

	/// Build a `ppid -> [pids]` map from a one-shot scan of `proc_listallpids`.
	///
	/// Used as the foundation of `Process::children` and `Process::descendants`
	/// on macOS where `proc_listchildpids` returns no children for self-queries.
	pub(super) fn build_process_tree() -> HashMap<i32, Vec<i32>> {
		let pids = sys::pids();
		let mut tree: HashMap<i32, Vec<i32>> = HashMap::with_capacity(pids.len() / 2);
		for pid in pids {
			let Some(info) = sys::bsdinfo(pid) else {
				continue;
			};
			let Ok(ppid) = i32::try_from(info.pbi_ppid) else {
				continue;
			};
			if ppid <= 0 {
				continue;
			}
			tree.entry(ppid).or_default().push(pid);
		}
		tree
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

	use super::ProcessStatus;

	const PROCESS_REFERENCE_ACCESS: u32 =
		sys::PROCESS_TERMINATE | sys::PROCESS_QUERY_LIMITED_INFORMATION | sys::SYNCHRONIZE;

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
			if pid <= 0 {
				return None;
			}
			let handle =
				Arc::new(sys::open_process(u32::try_from(pid).ok()?, PROCESS_REFERENCE_ACCESS)?);
			let creation_time = sys::process_times(&handle)?.0;
			Some(Self { pid, handle, creation_time })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
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

		pub fn children(&self) -> Vec<Self> {
			let tree = build_process_tree();
			self.children_from_tree(&tree)
		}

		/// Walk the entire descendant tree using a single Toolhelp snapshot.
		///
		/// `children()` recursing per-node would re-snapshot the whole process
		/// table for every visited descendant, making tree termination
		/// `O(N · D)` snapshots. One snapshot per termination wave is enough.
		pub fn descendants(&self) -> Vec<Self> {
			let tree = build_process_tree();
			let Ok(root) = u32::try_from(self.pid) else {
				return Vec::new();
			};
			let mut visited: HashSet<u32> = HashSet::new();
			visited.insert(root);
			let mut out = Vec::new();
			self.collect_descendants_from_tree(&tree, &mut visited, &mut out);
			out
		}

		/// The running process `child_pid`, when it really is a child of
		/// `self`. Windows never rewrites the parent id recorded for a process
		/// whose parent exited, so such an orphan is listed as a child of
		/// whichever process reuses that pid. A real child cannot have been
		/// created before its parent; an orphan older than `self` can.
		fn child(&self, child_pid: u32) -> Option<Self> {
			let child = Self::from_pid(i32::try_from(child_pid).ok()?)?;
			(child.creation_time >= self.creation_time && child.status() == ProcessStatus::Running)
				.then_some(child)
		}

		pub(super) fn children_from_tree(
			&self,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
		) -> Vec<Self> {
			let Ok(pid_u32) = u32::try_from(self.pid) else {
				return Vec::new();
			};
			tree
				.get(&pid_u32)
				.into_iter()
				.flatten()
				.filter_map(|&child_pid| self.child(child_pid))
				.collect()
		}

		fn collect_descendants_from_tree(
			&self,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
			visited: &mut HashSet<u32>,
			out: &mut Vec<Self>,
		) {
			let Some(children) = u32::try_from(self.pid).ok().and_then(|pid| tree.get(&pid)) else {
				return;
			};
			for &child_pid in children {
				if !visited.insert(child_pid) {
					continue;
				}
				let Some(child) = self.child(child_pid) else {
					continue;
				};
				// Post-order: collect grandchildren first so leaves are signalled
				// before their parents during tree termination.
				child.collect_descendants_from_tree(tree, visited, out);
				out.push(child);
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

	/// Build a map of `parent_pid` -> [`child_pids`] for all processes.
	fn build_process_tree() -> HashMap<u32, SmallVec<[u32; 4]>> {
		let mut tree: HashMap<u32, SmallVec<[u32; 4]>> = HashMap::new();
		for entry in sys::processes() {
			tree.entry(entry.ppid).or_default().push(entry.pid);
		}
		tree
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

/// Stable process reference.
#[derive(Clone)]
pub struct Process {
	inner: platform::Process,
}

impl Process {
	/// Open a stable process reference from a PID.
	pub fn from_pid(pid: i32) -> Option<Self> {
		platform::Process::from_pid(pid).map(Self::from_inner)
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

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	#[must_use]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
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
	pub fn children(&self) -> Vec<Self> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
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
	/// child whose pidfd cannot be opened (out of descriptors) is not read.
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
	fn live_descendants(&self) -> Vec<Self> {
		self
			.inner
			.descendants()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	fn signal_tree(&self, signal: i32) -> u32 {
		self.signal_tree_excluding(signal, &host_protected_pids())
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
	fn signal_tree_excluding(&self, signal: i32, protected: &HashSet<i32>) -> u32 {
		let descendants = self.signalable_descendants(protected);
		let mut signaled = 0u32;
		// If self leads its own process group, also signal the group — this
		// catches grandchildren reparented to init when their immediate parent
		// died inside the descendant walk.
		if let Some(pgid) = self.group_id()
			&& pgid == self.inner.pid()
		{
			let _ = kill_process_group(pgid, signal);
		}
		for child in &descendants {
			if child.inner.kill(signal) {
				signaled += 1;
			}
		}
		if !protected.contains(&self.pid()) && self.inner.kill(signal) {
			signaled += 1;
		}
		signaled
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
	fn signalable_descendants(&self, protected: &HashSet<i32>) -> Vec<Self> {
		let descendants = self.live_descendants();
		let parents: HashMap<i32, i32> = descendants
			.iter()
			.filter_map(|descendant| descendant.ppid().map(|parent| (descendant.pid(), parent)))
			.collect();
		descendants
			.into_iter()
			.filter(|descendant| !pid_in_protected_subtree(descendant.pid(), protected, &parents))
			.collect()
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
	/// The walk takes no cancellation: its waits are bounded.
	#[cfg(target_os = "linux")]
	async fn freeze(&self, signal: i32, protected: &HashSet<i32>, steps: bool) -> Frozen {
		// SAFETY: getpgrp takes no arguments and cannot fail.
		let own_group = unsafe { libc::getpgrp() };
		let mut frozen = Frozen { descendants: Vec::new(), stopped: Vec::new() };
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
				for child in process.children() {
					if !protected.contains(&child.pid()) && visited.insert(child.pid()) {
						next.push(child.clone());
						frozen.descendants.push(child);
					}
				}
			}
			level = next;
		}
		// Level by level, reversed: every child before its parent.
		frozen.descendants.reverse();
		frozen
	}

	/// One step of a stopped process that blocks `signal`: resume it and wait
	/// until it has left the stopped state; then wait, until `limit`, for it to
	/// sleep in the kernel, have another number of children, no longer block
	/// `signal` or end; then stop it again and wait up to [`STOP_WAIT_LIMIT`]
	/// for it to stop.
	#[cfg(target_os = "linux")]
	async fn step(&self, signal: i32, limit: tokio::time::Instant) {
		let children = self.inner.children().len();
		let _ = self.inner.kill(libc::SIGCONT);
		while self.inner.stopped()
			&& self.inner.children().len() == children
			&& tokio::time::Instant::now() < limit
		{
			tokio::time::sleep(STOP_POLL_INTERVAL).await;
		}
		while tokio::time::Instant::now() < limit
			&& self.inner.children().len() == children
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
		std::future::ready(Frozen { descendants: self.signalable_descendants(protected) })
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
		let timeout = Duration::from_millis(u64::from(timeout_ms));

		// Polite wave: SIGTERM the group, every live descendant, then the root.
		// It is sent even when `ct` has already fired: cancellation ends the
		// waits, not the signal.
		let polite = self
			.freeze(TERM_SIGNAL, &protected, graceful_ms >= 0)
			.await
			.signal(self, TERM_SIGNAL, process_group, &protected);

		// Optional grace wait. A negative `graceful_ms` skips the wait entirely
		// (we still emit the polite signal so cleanup handlers can run before
		// KILL).
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				self,
				&polite,
				process_group.map(|pgid| GroupWait { pgid, resend: None }),
				Some(Duration::from_millis(graceful_ms as u64)),
				ct.clone(),
			)
			.await?;
			if exited {
				return Ok(true);
			}
		}

		// Hard wave. Re-walk the tree so any grandchild spawned during the grace
		// period — or any process re-parented to the root — is signalled too,
		// along with every process the polite wave signalled that still runs,
		// and the tree under each: one whose parent died has left the tree,
		// and no walk from the root reaches it or what it forked since.
		let mut frozen = self.freeze(KILL_SIGNAL, &protected, true).await;
		for survivor in frozen.survivors(polite) {
			if frozen.holds(survivor.pid()) {
				continue;
			}
			let subtree = survivor.freeze(KILL_SIGNAL, &protected, true).await;
			frozen.absorb(subtree, survivor);
		}
		let descendants = frozen.signal(self, KILL_SIGNAL, process_group, &protected);

		let group = process_group.map(|pgid| GroupWait { pgid, resend: Some(KILL_SIGNAL) });
		wait_for_exit(self, &descendants, group, Some(timeout), ct).await
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
	descendants: Vec<Process>,
	/// Top-down, in the order they were stopped.
	#[cfg(target_os = "linux")]
	stopped:     Vec<Process>,
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
		self.descendants.iter().any(|process| process.pid() == pid)
	}

	/// Put `subtree` (the walk of `root`) and `root` ahead of the descendants,
	/// each process once, and take over the processes `subtree` stopped, so
	/// they resume once this wave is signalled.
	fn absorb(&mut self, mut subtree: Self, root: Process) {
		let mut held: HashSet<i32> = self.descendants.iter().map(Process::pid).collect();
		let mut added: Vec<Process> = std::mem::take(&mut subtree.descendants)
			.into_iter()
			.filter(|process| held.insert(process.pid()))
			.collect();
		if held.insert(root.pid()) {
			added.push(root);
		}
		self.descendants.splice(0..0, added);
		#[cfg(target_os = "linux")]
		self.stopped.append(&mut subtree.stopped);
	}

	/// Send `signal` to the group, the descendants, then `root`, and return the
	/// descendants. The stopped processes resume after it, and act on it then.
	fn signal(
		mut self,
		root: &Process,
		signal: i32,
		process_group: Option<i32>,
		protected: &HashSet<i32>,
	) -> Vec<Process> {
		#[cfg(all(test, target_os = "linux"))]
		wave_hook::run(root.pid());
		if let Some(pgid) = process_group {
			let _ = kill_process_group(pgid, signal);
		}
		for child in &self.descendants {
			let _ = child.inner.kill(signal);
		}
		if !protected.contains(&root.pid()) {
			let _ = root.inner.kill(signal);
		}
		#[cfg(all(test, target_os = "linux"))]
		wave_hook::run_after(root.pid(), signal);
		std::mem::take(&mut self.descendants)
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

	/// Send `signal` to every recorded target. Failures are swallowed:
	/// targets routinely exit between collection and signalling, and
	/// the caller's policy is "best effort".
	pub fn signal(&self, signal: i32) {
		for &pgid in &self.pgids {
			let _ = kill_process_group(pgid, signal);
		}
		for process in &self.processes {
			let _ = process.signal_tree(signal);
		}
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
		let signaled = root.signal_tree_excluding(KILL_SIGNAL, &protected);
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
		let reaped = root.signal_tree_excluding(KILL_SIGNAL, &HashSet::new());
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
			pin(newer_pid).children_from_tree(&tree).is_empty(),
			"an older process is not a child"
		);

		// The same entry is accepted when the listed child is newer.
		let tree = HashMap::from([(older_pid, smallvec::SmallVec::from_slice(&[newer_pid]))]);
		let children = pin(older_pid).children_from_tree(&tree);
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
			if harness
				.live_descendants()
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
		wait_until("the root runs its loop", || !process.children().is_empty());

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
						if let Some(child) = watched.children().into_iter().next() {
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
		wait_until("the root forked its sleep", || !process.children().is_empty());

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
		wait_until("the root forked its sleep", || !process.children().is_empty());
		let child = process.children().remove(0);
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
		wait_until("the root forked its sleep", || !process.children().is_empty());
		let child = process.children().remove(0);

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
				.first()
				.is_some_and(|child| comm(child.pid()) == "sleep")
		});
		let child = process.children().remove(0);

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
				.first()
				.is_some_and(|child| thread_state(child.pid()) == Some('T'))
		});
		let child = process.children().remove(0);

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
				&& process.children().is_empty()
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
			wait_until("the loop forked", || process.children().len() >= 3);
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
				&& process.children().is_empty()
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
				.first()
				.is_some_and(|subshell| subshell.children().len() >= 2)
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
				&& process.children().is_empty()
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
