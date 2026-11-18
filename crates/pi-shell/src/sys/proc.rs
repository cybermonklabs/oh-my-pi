//! The OS process table (Unix): who is in a session or process group, and
//! identity-pinned signalling.
//!
//! Used by the spawner's leak checks and KILL escalation, and by
//! conformance harnesses to clean up after each upstream test driver. A pid can
//! be recycled between a scan and a signal; every signal here first pins the
//! scanned process: on Linux through a pidfd plus a start-time recheck (the
//! signal then cannot reach another process), on macOS through a start-time
//! recheck immediately before `kill` (the remaining window is a pid wrapping
//! around within microseconds).

use std::io;

use bstr::BString;

use crate::bash::{Platform, Signal};

/// Makes this thread's reads of `/proc/<pid>/stat` fail with `errno`, for
/// `pid` (`None`: every pid), until the guard is dropped: `/proc` absent, or
/// one process's read refused, simulated.
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn fail_reads(fails: Vec<(Option<i32>, i32)>) -> impl Drop {
	struct Restore;
	impl Drop for Restore {
		fn drop(&mut self) {
			sys::FAIL_READS.with_borrow_mut(Vec::clear);
		}
	}
	sys::FAIL_READS.set(fails);
	Restore
}

/// One process of the table.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ProcInfo {
	/// Process id.
	pub pid:   i32,
	/// Parent pid.
	pub ppid:  i32,
	/// Process group.
	pub pgid:  i32,
	/// Session; `-1` when the kernel does not say (a macOS zombie).
	pub sid:   i32,
	/// Scheduling state.
	pub state: ProcState,
	/// Command name (`comm`).
	pub name:  BString,
	/// Kernel start time in platform units (Linux clock ticks since boot,
	/// macOS µs since the epoch); with `pid` it identifies the process.
	pub start: u64,
}

/// Coarse scheduling state of a [`ProcInfo`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum ProcState {
	/// Running or runnable.
	Running,
	/// Sleeping (interruptibly or not).
	Sleeping,
	/// Stopped by a signal or traced.
	Stopped,
	/// Exited, not yet reaped.
	Zombie,
	/// Anything else (idle kernel threads, being created, dead).
	Other,
}

/// Every process visible to the caller.
///
/// Fails, rather than leave a process out, when one could not be read for a
/// reason that can hide one of the caller's own: no descriptor or memory
/// left, an I/O error, a `stat` line that does not parse. A scan that leaves
/// out a running process reports it gone (a leak check finds no leftover).
/// A process that exited meanwhile (`ENOENT`, `ESRCH`) is left out, and so,
/// deliberately, is one the system will not show the caller (`EACCES`,
/// `EPERM`: another user's, under `hidepid`), which is never the caller's.
pub fn list() -> io::Result<Vec<ProcInfo>> {
	let (procs, complete) = scan();
	complete.map(|()| procs)
}

/// The processes [`list`] could read, and `Err` with the first failure that
/// can have left out one of the caller's own (see [`list`]). A kill uses
/// it: it signals what it read, and reports the failure after.
pub fn scan() -> (Vec<ProcInfo>, io::Result<()>) {
	sys::scan()
}

/// Whether a failure to read a process proves only that the process
/// exited, or that it is another user's (see [`list`]).
fn gone_or_foreign(error: &io::Error) -> bool {
	matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH | libc::EACCES | libc::EPERM))
}

/// The process `pid`, if it exists.
pub fn info(pid: i32) -> Option<ProcInfo> {
	sys::info(pid)
}

/// The process `pid`, for a check that must not miss one the caller may
/// signal.
///
/// `Ok(None)` only when the failed read proves no signal of the caller's
/// reaches it: it exited (`ESRCH`), or the read was refused (`ENOENT`,
/// `EACCES`, `EPERM`: another user's process under `hidepid`) and
/// `kill(pid, 0)` confirms the caller can signal no such process. `Err` for
/// any other failure, which proves nothing: no descriptor or memory left, an
/// I/O error, a line that does not parse, or a refused read of a process the
/// caller can still signal (no `/proc`, another pid namespace's, or a
/// set-user-ID child the caller started).
pub fn read(pid: i32) -> io::Result<Option<ProcInfo>> {
	match sys::read(pid) {
		Ok(found) => Ok(Some(found)),
		Err(error) if out_of_reach(pid, &error) => Ok(None),
		Err(error) => Err(error),
	}
}

/// Whether `error`, a failure to read the process `pid`, proves that no
/// signal of the caller's reaches it (see [`read`]).
pub(crate) fn out_of_reach(pid: i32, error: &io::Error) -> bool {
	match error.raw_os_error() {
		Some(libc::ESRCH) => true,
		// SAFETY: signal 0 sends nothing; it only checks the pid.
		Some(libc::ENOENT | libc::EACCES | libc::EPERM) => (unsafe { libc::kill(pid, 0) }) != 0,
		_ => false,
	}
}

/// Whether a process with the positive pid `pid` exists, a zombie included.
///
/// It asks the kernel (`kill(pid, 0)`), which fails with `ESRCH` only when
/// no process has the pid; a read of `/proc` can also fail with no
/// descriptor left or no permission.
pub fn exists(pid: i32) -> bool {
	// SAFETY: signal 0 sends nothing; it only checks the pid.
	let probed = unsafe { libc::kill(pid, 0) };
	probed == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Whether `pid` has ended: it is a zombie, or it does not [exist](exists).
///
/// A zombie exited and waits for its parent to reap it. A process whose
/// [`info`] cannot be read has not ended while it exists: a failed read
/// proves nothing.
pub fn ended(pid: i32) -> bool {
	info(pid).map_or_else(|| !exists(pid), |p| p.state == ProcState::Zombie)
}

/// Whether `pid` is running: its [`info`] was read, and it is no zombie (a
/// stopped process counts).
///
/// The positive evidence a check that a process is still alive needs: a
/// process that cannot be read is not running here, as it has not
/// [`ended`] there, since a failed read proves nothing.
pub fn running(pid: i32) -> bool {
	info(pid).is_some_and(|p| p.state != ProcState::Zombie)
}

/// The current instant in [`ProcInfo::start`] units: every process that
/// exists has `start <= now()`, and one started after the call has
/// `start >= ` the returned value (a "since" mark for containment checks).
///
/// Linux: `CLOCK_BOOTTIME` floored to clock ticks with integer math, the
/// same floor the kernel applies to `/proc/<pid>/stat` field 22 (parsing
/// `/proc/uptime` as a float can be a tick off). macOS: µs since the epoch,
/// like `pbi_start_tvsec`/`usec` (a wall clock: a step back in time breaks
/// the second guarantee).
pub fn now() -> io::Result<u64> {
	sys::now()
}

/// Processes whose session is `sid`, excluding the caller.
pub fn session_members(sid: i32) -> io::Result<Vec<ProcInfo>> {
	members(|p| p.sid == sid)
}

/// Processes whose process group is `pgid`, excluding the caller.
pub fn group_members(pgid: i32) -> io::Result<Vec<ProcInfo>> {
	members(|p| p.pgid == pgid)
}

fn members(pred: impl Fn(&ProcInfo) -> bool) -> io::Result<Vec<ProcInfo>> {
	let me = std::process::id() as i32;
	let mut all = list()?;
	all.retain(|p| p.pid != me && pred(p));
	Ok(all)
}

/// Signal every member of session `sid` (identity-pinned, zombies skipped);
/// returns the members signalled.
///
/// When the scan could not read every process ([`scan`]), the members it
/// read are signalled, then its error is returned.
pub fn kill_session(sid: i32, sig: Signal) -> io::Result<Vec<ProcInfo>> {
	kill_members(|p| p.sid == sid, sig)
}

/// Signal every member of process group `pgid`, as [`kill_session`] does.
pub fn kill_group(pgid: i32, sig: Signal) -> io::Result<Vec<ProcInfo>> {
	kill_members(|p| p.pgid == pgid, sig)
}

fn kill_members(pred: impl Fn(&ProcInfo) -> bool, sig: Signal) -> io::Result<Vec<ProcInfo>> {
	let me = std::process::id() as i32;
	let (mut all, complete) = scan();
	all.retain(|p| p.pid != me && pred(p));
	let (sent, signalled) = signal_all(all, sig);
	complete.and(signalled).map(|()| sent)
}

/// Signals every one of `procs` that is not a zombie, and returns those it
/// signalled with the first failure, if any: one process that cannot be
/// signalled does not keep the rest from being signalled.
fn signal_all(mut procs: Vec<ProcInfo>, sig: Signal) -> (Vec<ProcInfo>, io::Result<()>) {
	procs.retain(|p| p.state != ProcState::Zombie);
	let mut sent = Vec::with_capacity(procs.len());
	let mut outcome = Ok(());
	for p in procs {
		match signal_pinned(&p, sig) {
			Ok(true) => sent.push(p),
			Ok(false) => {},
			Err(error) => outcome = outcome.and(Err(error)),
		}
	}
	(sent, outcome)
}

/// Send `sig` to `p` if the pid still names the process that was scanned.
///
/// `Ok(false)` when it has exited, the pid now names another process, or the
/// process is another user's; an error when the process cannot be read for
/// any other reason (no descriptor left), since then nothing shows which
/// process the pid names.
pub fn signal_pinned(p: &ProcInfo, sig: Signal) -> io::Result<bool> {
	sys::signal_pinned(p, i32::from(sig.number(Platform::current())))
}

/// Split a Linux `/proc/<pid>/stat` line into `(comm, fields after comm)`.
/// The command name may itself contain spaces and parentheses, so it ends at
/// the *last* `)`.
#[cfg_attr(
	not(target_os = "linux"),
	allow(dead_code, reason = "Linux-only outside tests; the parser is tested everywhere")
)]
fn split_stat(line: &[u8]) -> Option<(&[u8], impl Iterator<Item = &[u8]>)> {
	let open = line.iter().position(|&b| b == b'(')?;
	let close = line.iter().rposition(|&b| b == b')')?;
	let comm = line.get(open + 1..close)?;
	let rest = line.get(close + 1..)?;
	Some((
		comm,
		rest
			.split(u8::is_ascii_whitespace)
			.filter(|f| !f.is_empty()),
	))
}

/// Parse a Linux `/proc/<pid>/stat` line.
#[cfg_attr(
	not(target_os = "linux"),
	allow(dead_code, reason = "Linux-only outside tests; the parser is tested everywhere")
)]
fn parse_stat(pid: i32, line: &[u8]) -> Option<ProcInfo> {
	fn num<T: std::str::FromStr>(f: &[u8]) -> Option<T> {
		std::str::from_utf8(f).ok()?.parse().ok()
	}
	let (comm, fields) = split_stat(line)?;
	let fields: Vec<&[u8]> = fields.take(20).collect();
	let state = match fields.first()?.first()? {
		b'R' => ProcState::Running,
		b'S' | b'D' => ProcState::Sleeping,
		b'T' | b't' => ProcState::Stopped,
		b'Z' => ProcState::Zombie,
		_ => ProcState::Other,
	};
	Some(ProcInfo {
		pid,
		ppid: num(fields.get(1)?)?,
		pgid: num(fields.get(2)?)?,
		sid: num(fields.get(3)?)?,
		state,
		name: BString::from(comm),
		start: num(fields.get(19)?)?,
	})
}

#[cfg(target_os = "linux")]
mod sys {
	use std::{
		fs,
		io::{self, Read},
		os::fd::{AsRawFd, FromRawFd, OwnedFd},
	};

	use super::{ProcInfo, gone_or_foreign, parse_stat};

	pub fn scan() -> (Vec<ProcInfo>, io::Result<()>) {
		let mut out = Vec::new();
		let entries = match fs::read_dir("/proc") {
			Ok(entries) => entries,
			Err(error) => return (out, Err(error)),
		};
		let mut complete = Ok(());
		for entry in entries {
			let entry = match entry {
				Ok(entry) => entry,
				Err(error) => {
					complete = complete.and(Err(error));
					continue;
				},
			};
			let Some(pid) = entry
				.file_name()
				.to_str()
				.and_then(|n| n.parse::<i32>().ok())
			else {
				continue;
			};
			match read(pid) {
				Ok(p) => out.push(p),
				// It exited between readdir and the read, or is another user's.
				Err(error) if gone_or_foreign(&error) => {},
				Err(error) => complete = complete.and(Err(error)),
			}
		}
		(out, complete)
	}

	pub fn info(pid: i32) -> Option<ProcInfo> {
		read(pid).ok()
	}

	#[cfg(test)]
	thread_local! {
		/// Reads of `/proc/<pid>/stat` on this thread fail with the paired
		/// `errno`, for that pid (`None`: every pid): `/proc` absent, or one
		/// process's read refused, without the kernel's help.
		pub(crate) static FAIL_READS: std::cell::RefCell<Vec<(Option<i32>, i32)>> =
			const { std::cell::RefCell::new(Vec::new()) };
	}

	/// `/proc/<pid>/stat`, parsed; `InvalidData` for a line that does not
	/// parse.
	pub(super) fn read(pid: i32) -> io::Result<ProcInfo> {
		#[cfg(test)]
		if let Some(errno) = FAIL_READS.with_borrow(|fails| {
			fails
				.iter()
				.find(|(at, _)| at.is_none_or(|at| at == pid))
				.map(|&(_, errno)| errno)
		}) {
			return Err(io::Error::from_raw_os_error(errno));
		}
		let mut file = fs::File::open(format!("/proc/{pid}/stat"))?;
		// The kernel hands over the whole line in one read when it fits (52
		// numbers and a name of at most 64 bytes do); `fs::read` grows from
		// 32 bytes a read at a time (a spawn reads its child's).
		let mut buf = [0; 1024];
		let n = file.read(&mut buf)?;
		let parsed = if n < buf.len() {
			parse_stat(pid, &buf[..n])
		} else {
			let mut line = buf.to_vec();
			file.read_to_end(&mut line)?;
			parse_stat(pid, &line)
		};
		parsed.ok_or_else(|| io::ErrorKind::InvalidData.into())
	}

	pub fn now() -> io::Result<u64> {
		// SAFETY: plain call without pointer arguments.
		let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
		let hz = u128::try_from(hz).map_err(|_| io::Error::last_os_error())?;
		let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
		// SAFETY: `ts` is writable for the call.
		if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &raw mut ts) } != 0 {
			return Err(io::Error::last_os_error());
		}
		let ns = ts.tv_sec as u128 * 1_000_000_000 + ts.tv_nsec as u128;
		Ok((ns * hz / 1_000_000_000) as u64)
	}

	fn pidfd_open(pid: i32) -> io::Result<OwnedFd> {
		// SAFETY: pidfd_open takes scalar arguments and returns a new fd.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
		if fd < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a successful pidfd_open returned a descriptor we now own.
		Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
	}

	pub fn signal_pinned(p: &ProcInfo, sig: i32) -> io::Result<bool> {
		let pidfd = match pidfd_open(p.pid) {
			Ok(fd) => Some(fd),
			Err(e) if e.raw_os_error() == Some(libc::ESRCH) => return Ok(false),
			// No pidfd from this system (kernels before 5.3: `ENOSYS`; a seccomp
			// or LSM filter: `EPERM`): fall back to a start-time recheck.
			Err(e) if matches!(e.raw_os_error(), Some(libc::ENOSYS | libc::EPERM)) => None,
			Err(e) => return Err(e),
		};
		// With the pidfd open the pid cannot be reused for another process
		// while we check that it still names the scanned one. A read that
		// fails for another reason than the process being gone or another
		// user's proves nothing either way, so it is the caller's error.
		match read(p.pid) {
			Ok(now) if now.start == p.start => {},
			Ok(_) => return Ok(false),
			Err(error) if gone_or_foreign(&error) => return Ok(false),
			Err(error) => return Err(error),
		}
		let rc = match &pidfd {
			// SAFETY: the pidfd is open for the call; a null siginfo makes the
			// kernel fill in what kill(2) would.
			Some(fd) => unsafe {
				libc::syscall(
					libc::SYS_pidfd_send_signal,
					fd.as_raw_fd(),
					sig,
					std::ptr::null::<libc::siginfo_t>(),
					0,
				) as i32
			},
			// SAFETY: plain syscall without pointer arguments.
			None => unsafe { libc::kill(p.pid, sig) },
		};
		if rc == 0 {
			return Ok(true);
		}
		let e = io::Error::last_os_error();
		if e.raw_os_error() == Some(libc::ESRCH) {
			Ok(false)
		} else {
			Err(e)
		}
	}
}

#[cfg(target_os = "macos")]
mod sys {
	use std::{ffi::CStr, io, mem, ptr};

	use bstr::BString;

	use super::{ProcInfo, ProcState, gone_or_foreign};

	pub fn scan() -> (Vec<ProcInfo>, io::Result<()>) {
		let pids = match all_pids() {
			Ok(pids) => pids,
			Err(error) => return (Vec::new(), Err(error)),
		};
		let mut out = Vec::with_capacity(pids.len());
		let mut complete = Ok(());
		for pid in pids.into_iter().filter(|&pid| pid > 0) {
			match read(pid) {
				Ok(p) => out.push(p),
				// It exited since the listing, or is not ours to read.
				Err(error) if gone_or_foreign(&error) => {},
				Err(error) => complete = complete.and(Err(error)),
			}
		}
		(out, complete)
	}

	fn all_pids() -> io::Result<Vec<i32>> {
		// SAFETY: a null buffer with size 0 is libproc's sizing query.
		let reported = unsafe { libc::proc_listallpids(ptr::null_mut(), 0) };
		if reported <= 0 {
			return Err(io::Error::last_os_error());
		}
		// Leave room for processes started since the sizing query.
		let capacity = (reported as usize).saturating_mul(2).max(1024);
		let mut pids = vec![0i32; capacity];
		let bytes = i32::try_from(capacity * mem::size_of::<i32>())
			.map_err(|e| io::Error::new(io::ErrorKind::OutOfMemory, e))?;
		// SAFETY: `pids` is writable for `bytes` bytes; libproc writes at most
		// that and returns the number of pids.
		let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
		if n < 0 {
			return Err(io::Error::last_os_error());
		}
		pids.truncate((n as usize).min(capacity));
		Ok(pids)
	}

	/// `PROC_PIDTBSDINFO` of `pid`. libproc's `proc_pidinfo` returns 0 and
	/// sets `errno` when the call fails; a short answer is `InvalidData`.
	fn bsdinfo(pid: i32) -> io::Result<libc::proc_bsdinfo> {
		// SAFETY: proc_bsdinfo is plain C integers and arrays, valid zeroed.
		let mut bi: libc::proc_bsdinfo = unsafe { mem::zeroed() };
		let size = mem::size_of::<libc::proc_bsdinfo>() as i32;
		// SAFETY: `bi` is writable for `size` bytes; arg 1 includes zombies.
		let got =
			unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 1, (&raw mut bi).cast(), size) };
		if got <= 0 {
			return Err(io::Error::last_os_error());
		}
		if got < size {
			return Err(io::ErrorKind::InvalidData.into());
		}
		Ok(bi)
	}

	fn c_name(raw: &[libc::c_char]) -> &[u8] {
		// SAFETY: `c_char` and `u8` have the same size and alignment.
		let bytes: &[u8] = unsafe { std::slice::from_raw_parts(raw.as_ptr().cast(), raw.len()) };
		CStr::from_bytes_until_nul(bytes).map_or(bytes, CStr::to_bytes)
	}

	pub fn info(pid: i32) -> Option<ProcInfo> {
		read(pid).ok()
	}

	pub(super) fn read(pid: i32) -> io::Result<ProcInfo> {
		let bi = bsdinfo(pid)?;
		// SAFETY: plain syscall without pointer arguments.
		let sid = unsafe { libc::getsid(pid) };
		let name = c_name(&bi.pbi_name);
		let name = if name.is_empty() {
			c_name(&bi.pbi_comm)
		} else {
			name
		};
		let state = match bi.pbi_status {
			2 => ProcState::Running,  // SRUN
			3 => ProcState::Sleeping, // SSLEEP
			4 => ProcState::Stopped,  // SSTOP
			5 => ProcState::Zombie,   // SZOMB
			_ => ProcState::Other,
		};
		Ok(ProcInfo {
			pid,
			ppid: bi.pbi_ppid as i32,
			pgid: bi.pbi_pgid as i32,
			sid,
			state,
			name: BString::from(name),
			start: bi
				.pbi_start_tvsec
				.saturating_mul(1_000_000)
				.saturating_add(bi.pbi_start_tvusec),
		})
	}

	pub fn now() -> io::Result<u64> {
		let since = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map_err(io::Error::other)?;
		Ok(since.as_micros() as u64)
	}

	pub fn signal_pinned(p: &ProcInfo, sig: i32) -> io::Result<bool> {
		match read(p.pid) {
			Ok(now) if now.start == p.start => {},
			Ok(_) => return Ok(false),
			Err(error) if gone_or_foreign(&error) => return Ok(false),
			Err(error) => return Err(error),
		}
		// SAFETY: plain syscall without pointer arguments.
		if unsafe { libc::kill(p.pid, sig) } == 0 {
			return Ok(true);
		}
		let e = io::Error::last_os_error();
		if e.raw_os_error() == Some(libc::ESRCH) {
			Ok(false)
		} else {
			Err(e)
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn stat_lines_with_hostile_command_names_parse() {
		let line = b"4242 (a) b (c) R 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0\n";
		let p = parse_stat(4242, line).unwrap();
		assert_eq!(p.name, "a) b (c");
		assert_eq!((p.ppid, p.pgid, p.sid), (1, 4242, 4242));
		assert_eq!(p.state, ProcState::Running);
		assert_eq!(p.start, 987654);
		assert!(parse_stat(1, b"1 (init) Z 0").is_none(), "truncated line");
	}

	#[test]
	fn the_scan_sees_this_process_and_its_session() {
		let me = std::process::id() as i32;
		let p = info(me).expect("own process");
		// SAFETY: plain syscalls without pointer arguments.
		let (pgid, sid) = unsafe { (libc::getpgid(0), libc::getsid(0)) };
		assert_eq!((p.pgid, p.sid), (pgid, sid));
		assert!(list().unwrap().iter().any(|q| q.pid == me));
		assert!(
			!session_members(sid).unwrap().iter().any(|q| q.pid == me),
			"members exclude the caller"
		);
	}

	#[test]
	fn now_brackets_process_start_times() {
		let me = info(std::process::id() as i32).unwrap();
		let since = now().unwrap();
		assert!(me.start <= since, "an existing process started before now()");
		// Linux start times have clock-tick (10 ms) resolution.
		std::thread::sleep(std::time::Duration::from_millis(30));
		let mut child = std::process::Command::new("/bin/sleep")
			.arg("5")
			.spawn()
			.unwrap();
		let start = info(child.id() as i32).unwrap().start;
		child.kill().unwrap();
		child.wait().unwrap();
		assert!(start >= since, "a later child started at or after the mark: {start} < {since}");
		assert!(start <= now().unwrap());
	}

	#[test]
	fn pinned_signal_skips_a_process_whose_start_time_changed() {
		let mut child = std::process::Command::new("/bin/sleep")
			.arg("5")
			.spawn()
			.unwrap();
		let pid = child.id() as i32;
		let mut p = info(pid).unwrap();
		p.start = p.start.wrapping_add(1);
		assert!(!signal_pinned(&p, Signal::Kill).unwrap(), "impostor identity is not signalled");
		assert!(child.try_wait().unwrap().is_none());
		p.start = p.start.wrapping_sub(1);
		assert!(signal_pinned(&p, Signal::Kill).unwrap());
		let status = child.wait().unwrap();
		assert!(!status.success());
	}

	/// [`ended`] tells a running process from one that has ended and waits
	/// to be reaped: tests judge a killed command by it, and under a PID 1
	/// that does not reap (a container started with `exec runuser`), a
	/// killed command stays a zombie, which `kill(pid, 0)` still finds.
	#[test]
	fn ended_counts_a_zombie_and_not_a_running_process() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.unwrap();
		let pid = child.id() as i32;
		let running_ended = ended(pid);
		// SAFETY: plain syscall; the test's own child.
		unsafe { libc::kill(pid, libc::SIGKILL) };
		// Not yet waited for, so the child stays a zombie of this process.
		// Waits for the zombie as long as that takes.
		let mut state = info(pid).map(|p| p.state);
		while state != Some(ProcState::Zombie) {
			std::thread::sleep(std::time::Duration::from_millis(10));
			state = info(pid).map(|p| p.state);
		}
		let zombie_ended = ended(pid);
		let zombie_exists = exists(pid);
		child.wait().unwrap();
		assert!(!running_ended, "the running sleep {pid} counts as ended");
		assert_eq!(state, Some(ProcState::Zombie), "sleep {pid} never became a zombie");
		assert!(zombie_ended, "the zombie {pid} does not count as ended");
		assert!(zombie_exists, "the zombie {pid} does not exist");
		assert!(!exists(pid) && ended(pid), "the reaped sleep {pid} still exists");
	}

	/// [`ended`] does not count a running process it cannot read as ended: a
	/// failed read of `/proc` is no proof the process ended. The check runs
	/// in a child test process, whose descriptor limit it lowers so that no
	/// file opens. Linux only: macOS reads a process without a descriptor.
	#[cfg(target_os = "linux")]
	#[test]
	fn ended_does_not_count_a_process_it_cannot_read() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.unwrap();
		let probed =
			short_of_descriptors::run("sys::proc::tests::ended_with_no_descriptor_left", child.id());
		let _ = child.kill();
		child.wait().unwrap();
		probed.unwrap();
	}

	/// Run by [`ended_does_not_count_a_process_it_cannot_read`] in a child
	/// process: with no descriptor left to open `/proc/<pid>/stat`, the
	/// running process it names must not count as ended.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by ended_does_not_count_a_process_it_cannot_read"]
	fn ended_with_no_descriptor_left() {
		let Some(pid) = short_of_descriptors::pid() else {
			return;
		};
		short_of_descriptors::leave_none();
		assert!(info(pid).is_none(), "/proc/{pid}/stat could still be read");
		assert!(exists(pid), "sleep {pid} is not running");
		assert!(!ended(pid), "the running sleep {pid} counts as ended when it cannot be read");
	}

	/// [`running`] needs positive evidence: a running process is, and a
	/// zombie, a reaped process and (in a child test process with no
	/// descriptor left) a running process it cannot read are not.
	#[test]
	fn running_needs_a_read_that_shows_the_process_running() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.unwrap();
		let pid = child.id() as i32;
		let was_running = running(pid);
		#[cfg(target_os = "linux")]
		let probed =
			short_of_descriptors::run("sys::proc::tests::running_with_no_descriptor_left", child.id());
		// SAFETY: plain syscall; the test's own child.
		unsafe { libc::kill(pid, libc::SIGKILL) };
		while info(pid).is_some_and(|p| p.state != ProcState::Zombie) {
			std::thread::sleep(std::time::Duration::from_millis(10));
		}
		let zombie_running = running(pid);
		child.wait().unwrap();
		#[cfg(target_os = "linux")]
		probed.unwrap();
		assert!(was_running, "the running sleep {pid} does not count as running");
		assert!(!zombie_running, "the zombie {pid} counts as running");
		assert!(!running(pid), "the reaped sleep {pid} counts as running");
	}

	/// Run by [`running_needs_a_read_that_shows_the_process_running`] in a
	/// child process: a running process it cannot read is not running.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by running_needs_a_read_that_shows_the_process_running"]
	fn running_with_no_descriptor_left() {
		let Some(pid) = short_of_descriptors::pid() else {
			return;
		};
		short_of_descriptors::leave_none();
		assert!(info(pid).is_none(), "/proc/{pid}/stat could still be read");
		assert!(exists(pid), "sleep {pid} is not running");
		assert!(!running(pid), "the sleep {pid} counts as running with no read to show it");
	}

	/// A scan of the process table fails, and so do the scans of a group or
	/// session on it, when it cannot read a process for want of a
	/// descriptor: leaving the process out would report it gone. The check
	/// runs in a child test process, with a descriptor for `/proc` and none
	/// for any `/proc/<pid>/stat`.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_scan_fails_when_it_cannot_read_a_process() {
		use std::os::unix::process::CommandExt as _;
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.process_group(0)
			.spawn()
			.unwrap();
		let probed =
			short_of_descriptors::run("sys::proc::tests::scan_with_one_descriptor_left", child.id());
		let _ = child.kill();
		child.wait().unwrap();
		probed.unwrap();
	}

	/// Run by [`a_scan_fails_when_it_cannot_read_a_process`] in a child
	/// process, for the process group of the process it names. The one
	/// descriptor left reads the process alone, but a scan holds it for the
	/// listing of `/proc`.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by a_scan_fails_when_it_cannot_read_a_process"]
	fn scan_with_one_descriptor_left() {
		let Some(pgid) = short_of_descriptors::pid() else {
			return;
		};
		let found: Vec<i32> = group_members(pgid).unwrap().iter().map(|p| p.pid).collect();
		assert_eq!(found, [pgid], "the control scan did not find the sleep");
		short_of_descriptors::leave_one();
		assert!(info(pgid).is_some(), "/proc/{pgid}/stat cannot be read with a descriptor left");
		let (read, complete) = scan();
		let failed = complete.expect_err("the scan reported no failure");
		assert_eq!(failed.raw_os_error(), Some(libc::EMFILE), "{failed}");
		assert!(!read.iter().any(|p| p.pid == pgid), "the sleep {pgid} was read after all");
		assert!(list().is_err(), "list left out what it could not read");
		assert!(group_members(pgid).is_err(), "group_members left out what it could not read");
		// SAFETY: plain call without pointer arguments.
		let sid = unsafe { libc::getsid(0) };
		assert!(session_members(sid).is_err(), "session_members left out what it could not read");
		assert!(kill_group(pgid, Signal::Kill).is_err(), "kill_group reported a whole scan");
		assert!(exists(pgid) && !ended(pgid), "the sleep {pgid} ended");
	}

	/// A pinned signal to a process it cannot read once its pidfd is open
	/// fails instead of reporting the process gone, so a KILL sweep does not
	/// skip a live process in silence. The check runs in a child test
	/// process, with one descriptor left, which the pidfd takes; where the
	/// system provides no pidfd, with none left, so the `stat` read of the
	/// start-time pin is the one that fails.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_pinned_signal_fails_when_it_cannot_read_the_process() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.unwrap();
		let probed = short_of_descriptors::run(
			"sys::proc::tests::pinned_signal_with_one_descriptor_left",
			child.id(),
		);
		let _ = child.kill();
		child.wait().unwrap();
		probed.unwrap();
	}

	/// Run by [`a_pinned_signal_fails_when_it_cannot_read_the_process`] in a
	/// child process.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "run in a child process by a_pinned_signal_fails_when_it_cannot_read_the_process"]
	fn pinned_signal_with_one_descriptor_left() {
		let Some(pid) = short_of_descriptors::pid() else {
			return;
		};
		let scanned = info(pid).expect("the control read of the sleep");
		if short_of_descriptors::pidfd_available() {
			short_of_descriptors::leave_one();
		} else {
			short_of_descriptors::leave_none();
		}
		let sent = signal_pinned(&scanned, Signal::Term);
		short_of_descriptors::restore();
		let failed = sent.expect_err("the pinned signal went out to a sleep it could not read");
		assert_eq!(failed.raw_os_error(), Some(libc::EMFILE), "{failed}");
		assert!(running(pid), "the sleep {pid} was signalled");
	}
}

/// Test support for checks that need a process short of descriptors: each
/// runs as an ignored test of this binary in a child process, which lowers
/// its own descriptor limit.
#[cfg(all(test, target_os = "linux"))]
pub(crate) mod short_of_descriptors {
	/// The variable naming the pid a child test judges.
	const PID: &str = "PI_SHELL_TEST_PROBE_PID";

	/// Runs the ignored test `test` (its whole path) in a child process of
	/// this test binary, to judge `pid`: `Err` with the child's output
	/// unless it ran, and passed. The caller cleans up before it asserts.
	pub(crate) fn run(test: &str, pid: u32) -> Result<(), String> {
		let probe = std::process::Command::new(std::env::current_exe().unwrap())
			.args(["--exact", test, "--ignored", "--nocapture", "--test-threads=1"])
			.env(PID, pid.to_string())
			.output()
			.unwrap();
		let out = String::from_utf8_lossy(&probe.stdout);
		let err = String::from_utf8_lossy(&probe.stderr);
		if !probe.status.success() {
			return Err(format!("{test} failed: {out}{err}"));
		}
		if !out.contains("1 passed") {
			return Err(format!("{test} did not run: {out}{err}"));
		}
		Ok(())
	}

	/// In the child test, the pid to judge; `None` when no parent test
	/// started it (`--include-ignored` runs it on its own, with nothing to
	/// judge).
	pub(crate) fn pid() -> Option<i32> {
		std::env::var(PID)
			.ok()
			.map(|pid| pid.parse().expect("a pid"))
	}

	/// No file opens from now on in this process.
	pub(crate) fn leave_none() {
		limit(0);
	}

	/// Whether this system provides `pidfd_open` (Linux 5.3, no seccomp
	/// filter against it): without it, a pin is by start time, which needs
	/// the `stat` read a pidfd would otherwise have spared.
	pub(crate) fn pidfd_available() -> bool {
		// SAFETY: pidfd_open takes scalar arguments; a descriptor it returns
		// is closed at once.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) };
		if fd < 0 {
			return !matches!(
				std::io::Error::last_os_error().raw_os_error(),
				Some(libc::ENOSYS | libc::EPERM)
			);
		}
		// SAFETY: `fd` is the descriptor pidfd_open just returned.
		unsafe { libc::close(fd as i32) };
		true
	}

	/// One more file opens from now on in this process, and no other.
	pub(crate) fn leave_one() {
		// SAFETY: duplicates a descriptor of this process and closes the copy:
		// the lowest free descriptor.
		let lowest = unsafe {
			let fd = libc::dup(0);
			assert!(fd >= 0, "no descriptor to duplicate");
			libc::close(fd);
			fd
		};
		limit(lowest as u64 + 1);
	}

	/// Files open again from now on in this process, up to its hard limit.
	pub(crate) fn restore() {
		let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
		// SAFETY: `limit` is writable for the call.
		assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut limit) }, 0);
		self::limit(limit.rlim_max);
	}

	fn limit(files: u64) {
		let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
		// SAFETY: `limit` is writable for the call.
		assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut limit) }, 0);
		limit.rlim_cur = files;
		// SAFETY: `limit` is readable for the call; this process only.
		assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const limit) }, 0);
	}
}
