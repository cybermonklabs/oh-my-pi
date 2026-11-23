//! Process groups, sessions, signals, escalation, pumps and leak checks
//! against real processes (`/bin/sh`, `sleep`, `yes`, `cat`).

use std::{
	io,
	os::{fd::AsRawFd as _, unix::process::CommandExt},
	sync::Arc,
	task::{Context, Poll, Wake, Waker},
	thread,
	time::Duration,
};

use bstr::{BString, ByteSlice};
use parking_lot::Mutex;

use super::{Scope, State, Sweep, process_umask};
use crate::{
	bash::{
		ChildRedir, ChildRedirs, CmdTag, EnvView, ExitStatus, ExtProc, File, FileKind, JobId, OnBusy,
		OpenFlags, OsHandle, PgroupSpec, Rlimit, RunId, SigSet, Signal, SpawnSpec, StdioSpec, Vpid,
	},
	sys::{
		proc::{self, ProcState},
		spawn::{NativeSpawner, Sessions, SpawnConfig},
	},
};

/// The parked tests' park timeout: past the runner's bound, so only a wake
/// (the exit) ends a park, and a test whose wake never comes is failed by
/// the test runner (`.config/nextest.toml`), never by a bound of its own.
#[cfg(target_os = "linux")]
const POLL: Duration = crate::testkit::child::LIFETIME;

/// A detached external is signalled through its session, whose group exists
/// only after the child's own `setsid`. A signal sent before that (`kill $!`
/// right after the spawn) must still reach the leader, here a process that
/// never leads a session at all.
#[test]
fn a_session_is_signalled_before_its_leader_ran_setsid() {
	let mut child = std::process::Command::new("sleep")
		.arg("30")
		.spawn()
		.unwrap();
	let pid = i32::try_from(child.id()).unwrap();
	Scope::Session(pid).signal(Signal::Term).unwrap();
	let status = child.wait().unwrap();
	assert_eq!(std::os::unix::process::ExitStatusExt::signal(&status), Some(libc::SIGTERM));
}

struct Unpark(thread::Thread);

impl Wake for Unpark {
	fn wake(self: Arc<Self>) {
		self.0.unpark();
	}
}

fn wait(p: &mut Box<dyn ExtProc>) -> ExitStatus {
	let waker = Waker::from(Arc::new(Unpark(thread::current())));
	let mut cx = Context::from_waker(&waker);
	loop {
		if let Poll::Ready(s) = p.poll_wait(&mut cx) {
			return s;
		}
		thread::park_timeout(Duration::from_millis(50));
	}
}

/// Poll `cond` until it holds.
fn until(_what: &str, mut cond: impl FnMut() -> bool) {
	while !cond() {
		thread::sleep(Duration::from_millis(5));
	}
}

fn argv(words: &[&str]) -> Vec<BString> {
	words.iter().map(|w| BString::from(*w)).collect()
}

fn sh(script: &str) -> Vec<BString> {
	argv(&["/bin/sh", "-c", script])
}

/// Spec with null stdio, cwd `/`, the process umask, nothing ignored.
fn spec<'a>(argv: &'a [BString], env: &'a EnvView, pgroup: PgroupSpec) -> SpawnSpec<'a> {
	SpawnSpec {
		path: argv[0].as_bstr(),
		argv,
		env,
		cwd: b"/".as_bstr(),
		stdio: [StdioSpec::Null, StdioSpec::Null, StdioSpec::Null],
		extra_fds: Vec::new(),
		pgroup,
		tag: CmdTag { run: RunId(1), vpid: Vpid(Vpid::BASE), seq: 1 },
		vpid: Vpid(Vpid::BASE),
		umask: process_umask().unwrap_or(0o022),
		sigmask_ign: SigSet::EMPTY,
		rlimits: &[],
		lineage: crate::bash::Lineage::default(),
		redirs: None,
		ctty: None,
		on_busy: OnBusy::Retry,
	}
}

const NEW: PgroupSpec = PgroupSpec::New(JobId(1));

fn spawner(sessions: Sessions, grace: Duration) -> NativeSpawner {
	NativeSpawner::new(SpawnConfig { grace, sessions, ..SpawnConfig::default() })
}

fn pgid(pid: u32) -> i32 {
	// SAFETY: plain syscall without pointer arguments.
	unsafe { libc::getpgid(pid as i32) }
}

fn sid(pid: u32) -> i32 {
	// SAFETY: plain syscall without pointer arguments.
	unsafe { libc::getsid(pid as i32) }
}

fn our_sid() -> i32 {
	sid(0)
}

/// Live (non-zombie) members of a group.
fn live_group(pgid: i32) -> Vec<proc::ProcInfo> {
	let mut m = proc::group_members(pgid).unwrap();
	m.retain(|p| p.state != ProcState::Zombie);
	m
}

/// The identity (pid and start) of each of `procs`, whatever its state.
fn ids(procs: &[proc::ProcInfo]) -> Vec<(i32, u64)> {
	let mut ids: Vec<_> = procs.iter().map(|p| (p.pid, p.start)).collect();
	ids.sort_unstable();
	ids
}

/// The record of the one escalation `s` started, once both its KILL step
/// and the sweep after it ran. Waits as long as that takes: the escalation
/// scans the process table, which takes seconds on a host with many
/// processes, so a deadline here would measure the host, not the
/// escalation (one that never ends hangs the test until the runner's
/// timeout).
fn escalated(s: &NativeSpawner) -> super::Escalation {
	loop {
		let all = s.escalations();
		assert!(all.len() <= 1, "one external, one escalation: {all:?}");
		if let Some(done) = all
			.into_iter()
			.find(|e| e.fired.as_ref().is_some_and(|f| f.swept.is_some()))
		{
			return done;
		}
		thread::sleep(Duration::from_millis(5));
	}
}

/// What escalation `e` of an external that still ran when it was dropped
/// recorded at its KILL step: it was due exactly `grace` after the drop (the
/// schedule, whatever the host's speed) and ran no earlier, with the
/// processes alive then (`alive`, what TERM left) and KILL sent to the
/// scope. Returns how long after the drop it ran, for the log.
fn assert_killed_after(
	e: &super::Escalation,
	grace: Duration,
	alive: &[proc::ProcInfo],
) -> Duration {
	let fired = e.fired.as_ref().expect("the KILL step ran");
	assert!(e.running, "the external ran when dropped: {e:?}");
	let due = fired.due.duration_since(e.abandoned);
	assert_eq!(fired.due, e.abandoned + grace, "KILL was due {due:?} after the drop, not {grace:?}");
	assert!(fired.at >= fired.due, "the KILL step ran before it was due: {e:?}");
	let after = fired.at.duration_since(e.abandoned);
	let found = fired.alive.as_deref().expect("the scope was read");
	assert_eq!(ids(found), ids(alive), "alive when KILL was due: {found:?}");
	assert!(fired.killed, "KILL went to the scope: {e:?}");
	after
}

/// An engine-side file without an OS handle: a byte source, a capture, or a
/// sink whose reader is gone.
#[derive(Clone, Default)]
struct MemFile {
	input:    Arc<Mutex<(Vec<u8>, usize)>>,
	output:   Arc<Mutex<Vec<u8>>>,
	broken:   bool,
	/// Refuse reads / writes like an fd opened the other way.
	no_read:  bool,
	no_write: bool,
	/// `seek(Current(n))` moves the input position (a VFS file).
	seekable: bool,
}

impl MemFile {
	/// A read end like the engine's `<( )` pipe end.
	fn reader(data: &[u8]) -> Self {
		Self { no_write: true, ..Self::feed(data) }
	}

	/// A write end like the engine's `>( )` pipe end.
	fn writer() -> Self {
		Self { no_read: true, ..Self::default() }
	}

	fn feed(data: &[u8]) -> Self {
		Self { input: Arc::new(Mutex::new((data.to_vec(), 0))), ..Self::default() }
	}

	fn broken() -> Self {
		Self { broken: true, ..Self::default() }
	}

	fn captured(&self) -> Vec<u8> {
		self.output.lock().clone()
	}

	fn boxed(&self) -> StdioSpec {
		StdioSpec::File(Box::new(self.clone()))
	}
}

impl File for MemFile {
	fn poll_read(&mut self, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		if self.no_read {
			return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
		}
		let mut g = self.input.lock();
		let (data, pos) = &mut *g;
		let n = buf.len().min(data.len() - *pos);
		buf[..n].copy_from_slice(&data[*pos..*pos + n]);
		*pos += n;
		Poll::Ready(Ok(n))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		if self.no_write {
			return Poll::Ready(Err(io::ErrorKind::Unsupported.into()));
		}
		if self.broken {
			return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
		}
		self.output.lock().extend_from_slice(buf);
		Poll::Ready(Ok(buf.len()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
		let io::SeekFrom::Current(off) = pos else {
			return Err(io::ErrorKind::Unsupported.into());
		};
		if !self.seekable {
			return Err(io::ErrorKind::Unsupported.into());
		}
		let mut g = self.input.lock();
		let at =
			g.1.checked_add_signed(off as isize)
				.filter(|&at| at <= g.0.len())
				.ok_or(io::ErrorKind::InvalidInput)?;
		g.1 = at;
		Ok(at as u64)
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

/// `f(){ date; cat "$1"; }; f <(echo l8r)`: an external that never reads
/// its feed leaves the bytes the pump moved into the OS pipe; dropping its
/// `ExtProc` gives them back to the engine object at once, so the next
/// reader (here another external) gets them.
#[test]
fn bytes_left_in_a_feed_go_back_to_the_engine_object_when_its_external_is_done() {
	let env = EnvView::default();
	let spawner = NativeSpawner::default();
	let data = b"l8r\n";
	let src = MemFile { seekable: true, ..MemFile::reader(data) };
	let sub = crate::bash::FdRef::from_file(Box::new(src.clone()));
	let idle = sh("exit 0");
	let mut first = spec(&idle, &env, NEW);
	first.extra_fds = vec![(63, StdioSpec::Pipe(sub.clone()))];
	let mut p = spawner.spawn(first).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	until("the pump took the bytes", || src.input.lock().1 == data.len());
	drop(p);
	assert_eq!(src.input.lock().1, 0, "given back by the drop, before it returns");

	let out = MemFile::default();
	let cat = argv(&["/bin/cat"]);
	let mut second = spec(&cat, &env, NEW);
	second.stdio = [StdioSpec::Pipe(sub), out.boxed(), StdioSpec::Null];
	let mut p = spawner.spawn(second).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured(), data, "the next reader gets every byte");
}

#[test]
fn exit_codes_and_group_signals_are_reported() {
	let env = EnvView::default();
	for sessions in [Sessions::Detach, Sessions::Share] {
		let s = spawner(sessions, Duration::from_secs(2));
		let a = sh("exit 3");
		let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Exited(3));

		let a = argv(&["/bin/sleep", "30"]);
		let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
		p.signal(Signal::Term).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Term), "{sessions:?}");
	}
}

/// More externals at once than waiters are kept parked, then a sequential
/// round that reuses the parked ones: every exit reaches its own external.
#[test]
fn parked_waiters_report_each_external_its_own_exit() {
	let env = EnvView::default();
	let s = spawner(Sessions::Inherit, Duration::from_secs(2));
	let scripts: Vec<Vec<BString>> = (0..super::IDLE_MAX + 4)
		.map(|i| sh(&format!("sleep 0.2; exit {i}")))
		.collect();
	let mut running: Vec<_> = scripts
		.iter()
		.map(|a| s.spawn(spec(a, &env, NEW)).unwrap())
		.collect();
	for (i, p) in running.iter_mut().enumerate().rev() {
		assert_eq!(wait(p), ExitStatus::Exited(i32::try_from(i).unwrap()));
	}
	drop(running);
	for i in 0..2 * super::IDLE_MAX {
		let a = sh(&format!("exit {i}"));
		let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Exited(i32::try_from(i).unwrap()));
	}
	assert!(s.leftovers().unwrap().is_empty());
}

#[test]
fn missing_program_fails_with_not_found_on_both_paths() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = argv(&["/nonexistent/prog"]);
	let err = s.spawn(spec(&a, &env, NEW)).err().unwrap();
	assert_eq!(err.kind(), io::ErrorKind::NotFound, "posix_spawn path");
	let mut forked = spec(&a, &env, NEW);
	forked.umask = if forked.umask == 0o077 { 0o027 } else { 0o077 };
	let err = s.spawn(forked).err().unwrap();
	assert_eq!(err.kind(), io::ErrorKind::NotFound, "fork path");
}

/// A script without `#!` cannot be exec'd: the spawn must fail with the
/// kernel's ENOEXEC intact, so the host can run it in-engine as bash does.
/// [`crate::testprog`] writes the script from a child, so no fork by another
/// test's thread holds it open for writing (which fails the spawn with
/// ETXTBSY instead).
#[test]
fn shebang_less_script_fails_with_enoexec_on_both_paths() {
	let path = std::env::temp_dir().join(format!("obash-noexec-{}", std::process::id()));
	crate::testprog::write(&path, "echo inscript $1\n");
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = vec![BString::from(path.as_os_str().as_encoded_bytes()), BString::from("arg")];
	let posix = spec(&a, &env, NEW);
	let mut forked = spec(&a, &env, NEW);
	forked.umask = if forked.umask == 0o077 { 0o027 } else { 0o077 };
	for (what, sp) in [("posix_spawn", posix), ("fork", forked)] {
		let err = s
			.spawn(sp)
			.err()
			.unwrap_or_else(|| panic!("{what}: spawned a shebang-less script"));
		assert_eq!(err.raw_os_error(), Some(libc::ENOEXEC), "{what}: {err}");
	}
	std::fs::remove_file(&path).unwrap();
}

/// A fresh path in the temp directory for test `what`.
fn temp_path(what: &str) -> std::path::PathBuf {
	std::env::temp_dir().join(format!("obash-{what}-{}", std::process::id()))
}

/// The open of `path` with `flags` onto `fds` by the process.
fn child_open(fds: &[i32], path: &std::path::Path, flags: OpenFlags) -> ChildRedir {
	let path = BString::from(path.as_os_str().as_encoded_bytes());
	let diag = BString::from(format!("test: {path}: "));
	ChildRedir::Open { fds: fds.to_vec(), path, flags, mode: 0o600, diag }
}

const WRITE: OpenFlags = OpenFlags::WRITE
	.with(OpenFlags::CREATE)
	.with(OpenFlags::TRUNC);

/// An exec that keeps failing with ETXTBSY is tried once more after each
/// wait of `BUSY_WAITS_MS`, and the last ETXTBSY is reported (the child of
/// `fork_redirs` tries this way): the waits are counted here, not timed.
#[test]
fn a_busy_exec_is_tried_after_each_wait_then_reported() {
	let mut tries = 0;
	let mut waited = Vec::new();
	let busy: io::Result<()> = super::retry_busy(
		|| {
			tries += 1;
			Err(io::Error::from_raw_os_error(libc::ETXTBSY))
		},
		|ms| waited.push(ms),
	);
	assert_eq!(busy.unwrap_err().raw_os_error(), Some(libc::ETXTBSY));
	assert_eq!(waited, super::super::BUSY_WAITS_MS);
	assert_eq!(tries, super::super::BUSY_WAITS_MS.len() + 1);
	assert_eq!(super::super::BUSY_WAITS_MS.iter().sum::<u64>(), 1023);
}

/// A busy exec that clears goes on at once, after only the waits so far;
/// every other error is reported on the first try, without a wait, and so
/// is the error of a spawn that a caller would try again after waits.
#[test]
fn only_a_busy_exec_is_tried_again() {
	let mut busy_left = 2;
	let mut waited = Vec::new();
	let ran = super::retry_busy(
		|| {
			if busy_left == 0 {
				return Ok(7);
			}
			busy_left -= 1;
			Err(io::Error::from_raw_os_error(libc::ETXTBSY))
		},
		|ms| waited.push(ms),
	);
	assert_eq!(ran.unwrap(), 7);
	assert_eq!(waited, [1, 2]);
	for errno in [libc::ENOEXEC, libc::ENOENT, libc::EACCES, libc::E2BIG] {
		let (mut tries, mut waits) = (0, 0);
		let failed: io::Result<()> = super::retry_busy(
			|| {
				tries += 1;
				Err(io::Error::from_raw_os_error(errno))
			},
			|_| waits += 1,
		);
		assert_eq!((failed.unwrap_err().raw_os_error(), tries, waits), (Some(errno), 1, 0));
	}
	let env = EnvView::default();
	let a = argv(&["/nonexistent/prog"]);
	let mut waits = 0;
	let failed = settle_now(NativeSpawner::default().start(spec(&a, &env, NEW)), |_| {
		waits += 1;
		Box::new(Fired)
	});
	assert_eq!((failed.err().map(|e| e.kind()), waits), (Some(io::ErrorKind::NotFound), 0));
}

/// A timer that has fired: a test's wait, over at once.
struct Fired;

impl crate::bash::Timer for Fired {
	fn poll(&mut self, _cx: &mut Context<'_>) -> Poll<()> {
		Poll::Ready(())
	}
}

/// `started` settled, its waits on `sleep`'s timers: the test's, which have
/// fired, so one poll settles it.
fn settle_now(
	started: super::Started,
	sleep: impl FnMut(Duration) -> Box<dyn crate::bash::Timer>,
) -> io::Result<Box<dyn ExtProc>> {
	let mut settling = std::pin::pin!(started.settle(sleep));
	match settling
		.as_mut()
		.poll(&mut Context::from_waker(Waker::noop()))
	{
		Poll::Ready(settled) => settled,
		Poll::Pending => panic!("a spawn whose waits have fired is settled at once"),
	}
}

/// Whether this kernel refuses to run a program held open for writing
/// (Linux does; gVisor runs it). The probe is a program in `dir`, the
/// calling test's own directory.
#[cfg(target_os = "linux")]
fn busy_exec_refused(dir: &std::path::Path) -> bool {
	let program = dir.join("busy-probe");
	write_program(&program, "#!/bin/sh\nexit 0\n");
	let held = std::fs::OpenOptions::new()
		.append(true)
		.open(&program)
		.expect("open the probe for writing");
	let ran = std::process::Command::new(&program).status();
	drop(held);
	ran.err().and_then(|e| e.raw_os_error()) == Some(libc::ETXTBSY)
}

/// Says on the test binary's stderr, past libtest's capture, that `test`
/// did not run: this kernel runs a program held open for writing, so there
/// is no busy exec to retry. The policy tests cover the retry there.
#[cfg(target_os = "linux")]
fn say_not_run(test: &str) {
	use std::io::Write as _;
	let _ = writeln!(
		std::io::stderr(),
		"NOT-RUN {test}: this kernel runs a program held open for writing"
	);
}

/// Writes `text` to `path`, mode 0755.
#[cfg(target_os = "linux")]
fn write_program(path: &std::path::Path, text: &str) {
	use std::os::unix::fs::PermissionsExt as _;
	std::fs::write(path, text).expect("write the program");
	std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
}

/// A process that holds a program open for writing until it is killed (a
/// `sleep` with the file on fd 3, opened before it says `held`): another
/// session's child before its exec.
#[cfg(target_os = "linux")]
struct Holder(std::process::Child);

#[cfg(target_os = "linux")]
impl Holder {
	fn new(program: &std::path::Path) -> Self {
		use std::io::BufRead as _;
		let mut child = std::process::Command::new("/bin/sh")
			.args(["-c", "exec 3>>\"$0\" && echo held && exec sleep 600"])
			.arg(program)
			.stdout(std::process::Stdio::piped())
			.spawn()
			.expect("start the holder");
		let mut said = String::new();
		std::io::BufReader::new(child.stdout.as_mut().expect("holder stdout"))
			.read_line(&mut said)
			.expect("read the holder");
		assert_eq!(said, "held\n", "the holder opened the program for writing");
		Self(child)
	}

	fn pid(&self) -> libc::pid_t {
		libc::pid_t::try_from(self.0.id()).unwrap()
	}
}

#[cfg(target_os = "linux")]
impl Drop for Holder {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}

/// The spec of the spawn of `program` by path `kind` (`posix_spawn`, the
/// fork path, or the deferred fork whose child reports a failed exec on its
/// fd 2, here the file `err`, and by its status).
#[cfg(target_os = "linux")]
fn spec_by<'a>(
	kind: &str,
	program: &'a [BString],
	env: &'a EnvView,
	err: &std::path::Path,
) -> SpawnSpec<'a> {
	let mut sp = spec(program, env, NEW);
	match kind {
		"posix_spawn" => {},
		"fork" => sp.umask = if sp.umask == 0o077 { 0o027 } else { 0o077 },
		"deferred" => {
			sp.redirs = Some(ChildRedirs {
				list:      vec![child_open(&[2], err, WRITE)],
				exec_diag: BString::from("test: "),
			});
		},
		_ => unreachable!("{kind}"),
	}
	sp
}

/// The spawn of `program` by path `kind` ([`spec_by`]), one try.
#[cfg(target_os = "linux")]
fn spawn_by(
	s: &NativeSpawner,
	kind: &str,
	program: &[BString],
	env: &EnvView,
	err: &std::path::Path,
) -> io::Result<Box<dyn ExtProc>> {
	s.spawn(spec_by(kind, program, env, err))
}

#[cfg(target_os = "linux")]
const BUSY_PATHS: [&str; 3] = ["posix_spawn", "fork", "deferred"];

/// On every spawn path, a program another process holds open for writing
/// runs once that process lets go within the waits. On the `posix_spawn`
/// and fork paths the first try fails with no process left of it, and the
/// holder is killed at the first wait, a timer of the test's; the deferred
/// fork's child waits itself, and kills the holder at its first wait
/// (`KILL_AT_BUSY_WAIT`). Every file is in this test's own directory.
#[cfg(target_os = "linux")]
#[test]
fn a_busy_program_runs_once_its_holder_lets_go() {
	let dir = tempfile::tempdir().expect("the test's directory");
	if !busy_exec_refused(dir.path()) {
		say_not_run("a_busy_program_runs_once_its_holder_lets_go");
		return;
	}
	let env = EnvView::default();
	let s = NativeSpawner::default();
	for kind in BUSY_PATHS {
		let program = dir.path().join(kind);
		let err = dir.path().join(format!("{kind}.err"));
		write_program(&program, "#!/bin/sh\nexit 7\n");
		let holder = Holder::new(&program);
		let a = vec![BString::from(program.as_os_str().as_encoded_bytes())];
		let spawned = if kind == "deferred" {
			super::KILL_AT_BUSY_WAIT.set(holder.pid());
			let spawned = spawn_by(&s, kind, &a, &env, &err);
			super::KILL_AT_BUSY_WAIT.set(0);
			spawned
		} else {
			let mut holder = Some(holder);
			let mut waited = Vec::new();
			let spawned = settle_now(s.start(spec_by(kind, &a, &env, &err)), |wait| {
				waited.push(wait);
				drop(holder.take());
				Box::new(Fired)
			});
			assert_eq!(waited, [Duration::from_millis(1)], "{kind}: one wait");
			spawned
		};
		let status = spawned.map(|mut p| wait(&mut p));
		let said = std::fs::read_to_string(&err).unwrap_or_default();
		assert_eq!(status.map_err(|e| e.to_string()), Ok(ExitStatus::Exited(7)), "{kind}: {said}");
	}
}

/// On every spawn path, a program that stays open for writing still fails
/// with ETXTBSY once the waits run out, as bash fails at once. On the
/// `posix_spawn` and fork paths the waits are counted: one timer of the
/// caller's for each of `BUSY_WAITS_MS`, in order (here timers that have
/// fired). Every file is in this test's own directory.
#[cfg(target_os = "linux")]
#[test]
fn a_program_that_stays_busy_fails_after_the_waits() {
	let dir = tempfile::tempdir().expect("the test's directory");
	if !busy_exec_refused(dir.path()) {
		say_not_run("a_program_that_stays_busy_fails_after_the_waits");
		return;
	}
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let all_waits: Vec<Duration> = super::super::BUSY_WAITS_MS
		.iter()
		.map(|&ms| Duration::from_millis(ms))
		.collect();
	for kind in BUSY_PATHS {
		let program = dir.path().join(kind);
		let err = dir.path().join(format!("{kind}.err"));
		write_program(&program, "#!/bin/sh\nexit 7\n");
		let holder = Holder::new(&program);
		let a = vec![BString::from(program.as_os_str().as_encoded_bytes())];
		let failure = if kind == "deferred" {
			let mut p = spawn_by(&s, kind, &a, &env, &err).expect("the deferred spawn");
			let status = wait(&mut p);
			format!("{status:?}: {}", std::fs::read_to_string(&err).unwrap_or_default())
		} else {
			let mut waited = Vec::new();
			let settled = settle_now(s.start(spec_by(kind, &a, &env, &err)), |wait| {
				waited.push(wait);
				Box::new(Fired)
			});
			assert_eq!(waited, all_waits, "{kind}: every wait, in order");
			match settled {
				Err(e) => e.to_string(),
				Ok(mut p) => format!("ran: {:?}", wait(&mut p)),
			}
		};
		drop(holder);
		let expected = if kind == "deferred" {
			"Exited(126): test: Text file busy\n".to_owned()
		} else {
			io::Error::from_raw_os_error(libc::ETXTBSY).to_string()
		};
		assert_eq!(failure, expected, "{kind}");
	}
}

/// A `sleep` a test watches die: the spawn under test kills it when it
/// finds its program busy (`KILL_AT_BUSY_WAIT`), the sign that it waits.
#[cfg(target_os = "linux")]
struct Sentinel(std::process::Child);

#[cfg(target_os = "linux")]
impl Sentinel {
	fn new() -> Self {
		Self(
			std::process::Command::new("sleep")
				.arg("600")
				.spawn()
				.expect("start the sentinel"),
		)
	}

	fn pid(&self) -> libc::pid_t {
		libc::pid_t::try_from(self.0.id()).unwrap()
	}

	/// Whether it died (reaped, then).
	fn died(&mut self) -> bool {
		self.0.try_wait().expect("the sentinel's state").is_some()
	}
}

#[cfg(target_os = "linux")]
impl Drop for Sentinel {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}

/// A runtime with one thread, which drives the session and every other
/// task of a test.
#[cfg(target_os = "linux")]
fn one_thread() -> tokio::runtime::Runtime {
	tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.expect("a runtime")
}

/// A shell session's spawn paths: `posix_spawn` for a command run with
/// the process's umask, the fork path for one run with another.
#[cfg(target_os = "linux")]
const SESSION_PATHS: [&str; 2] = ["posix_spawn", "fork"];

/// `then` after the program `./name` in the test's directory, run on the
/// session's spawn path `kind`.
#[cfg(target_os = "linux")]
fn run_by(kind: &str, name: &str, then: &str) -> String {
	match kind {
		"posix_spawn" => format!("./{name}; {then}"),
		"fork" => {
			let other = if process_umask() == Some(0o077) {
				"027"
			} else {
				"077"
			};
			format!("umask {other}; ./{name}; {then}")
		},
		_ => unreachable!("{kind}"),
	}
}

/// A run of `command` in `dir`.
#[cfg(target_os = "linux")]
fn run_in(dir: &std::path::Path, command: String) -> crate::shell::ShellRunOptions {
	crate::shell::ShellRunOptions {
		command,
		cwd: Some(dir.to_string_lossy().into_owned()),
		..Default::default()
	}
}

/// Makes reads of `pipe` return `WouldBlock` instead of waiting.
#[cfg(target_os = "linux")]
fn nonblocking(pipe: &std::io::PipeReader) {
	use std::os::fd::AsRawFd as _;
	// SAFETY: fcntl on a descriptor the caller holds.
	unsafe {
		let flags = libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL);
		assert!(flags >= 0, "F_GETFL");
		assert!(
			libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) == 0,
			"F_SETFL"
		);
	}
}

/// Whether `pipe` reaches end of file with nothing read from it. A read
/// that would wait yields the runtime's thread to its other tasks (the
/// run) and tries again: a child that holds the write end delays the end
/// of file without stopping the run.
#[cfg(target_os = "linux")]
async fn reaches_end_of_file(pipe: &std::io::PipeReader) -> bool {
	nonblocking(pipe);
	loop {
		match std::io::Read::read(&mut &*pipe, &mut [0u8; 1]) {
			Ok(read) => return read == 0,
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => tokio::task::yield_now().await,
			Err(e) => panic!("read the pipe: {e}"),
		}
	}
}

/// What `pipe` holds now, read without waiting for more.
#[cfg(target_os = "linux")]
fn drain(pipe: &mut std::io::PipeReader) -> Vec<u8> {
	nonblocking(pipe);
	let mut got = Vec::new();
	let mut buf = [0u8; 256];
	loop {
		match std::io::Read::read(pipe, &mut buf) {
			Ok(0) => return got,
			Ok(n) => got.extend_from_slice(&buf[..n]),
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => return got,
			Err(e) => panic!("read the pipe: {e}"),
		}
	}
}

/// While a session's spawn waits for a busy program, the one thread that
/// drives the session runs other tasks: a timer of another task fires, a
/// pipe the host closed reaches end of file, and that task then lets the
/// program go, which the spawn's next try runs. The spawn's first busy try
/// kills the sentinel (`KILL_AT_BUSY_WAIT`), so the other task starts only
/// once the spawn waits; one that waited on the session's thread would have
/// failed with ETXTBSY (126) before the other task ran. Every wait is the
/// host's own: each one reports its process's pid (`BUSY_WAIT_REPORT`),
/// and a child that waited for its exec (holding every descriptor of the
/// host meanwhile) would report its own.
#[cfg(target_os = "linux")]
#[test]
fn a_busy_spawn_leaves_its_thread_to_other_tasks() {
	let dir = tempfile::tempdir().expect("the test's directory");
	if !busy_exec_refused(dir.path()) {
		say_not_run("a_busy_spawn_leaves_its_thread_to_other_tasks");
		return;
	}
	for kind in SESSION_PATHS {
		write_program(&dir.path().join(kind), "#!/bin/sh\nexit 7\n");
		let holder = Holder::new(&dir.path().join(kind));
		let mut sentinel = Sentinel::new();
		let (host_reads, host_writes) = std::io::pipe().expect("a pipe of the host's");
		let (mut reports, report_to) = std::io::pipe().expect("the wait reports' pipe");
		super::KILL_AT_BUSY_WAIT.set(sentinel.pid());
		super::BUSY_WAIT_REPORT.set(std::os::fd::AsRawFd::as_raw_fd(&report_to));
		let shell = crate::shell::Shell::new(None);
		let (ran, end_of_file) = one_thread().block_on(async {
			let run = shell.run(
				run_in(dir.path(), run_by(kind, kind, "exit $?")),
				None,
				crate::cancel::CancelToken::default(),
			);
			let other = async move {
				while !sentinel.died() {
					tokio::task::yield_now().await;
				}
				tokio::time::sleep(Duration::from_millis(1)).await;
				drop(host_writes);
				let end_of_file = reaches_end_of_file(&host_reads).await;
				drop(holder);
				end_of_file
			};
			tokio::join!(run, other)
		});
		super::KILL_AT_BUSY_WAIT.set(0);
		super::BUSY_WAIT_REPORT.set(-1);
		// Every wait happened before the run ended, so its report is in the
		// pipe: read what is there, without waiting for an end of file that
		// another test's child (holding a copy until its exec) could delay.
		let reported = drain(&mut reports);
		drop(report_to);
		let waiters: Vec<u32> = reported
			.as_chunks::<4>()
			.0
			.iter()
			.map(|pid| u32::from_ne_bytes(*pid))
			.collect();
		assert!(!waiters.is_empty(), "{kind}: the spawn waited");
		assert!(
			waiters.iter().all(|&pid| pid == std::process::id()),
			"{kind}: a process other than the host ({}) waited: {waiters:?}",
			std::process::id()
		);
		assert!(end_of_file, "{kind}: nothing wrote to the pipe");
		let ran = ran.expect("the run");
		assert_eq!(
			ran.exit_code,
			Some(7),
			"{kind}: the program ran once the other task let go: {ran:?}"
		);
	}
}

/// What a run printed, and whether the command after the program ran.
#[cfg(target_os = "linux")]
fn run_record(said: &flume::Receiver<String>, after: &std::path::Path) -> (String, bool) {
	(said.drain().collect(), after.exists())
}

/// `Shell::abort` while the session's spawn waits for a busy program ends
/// the run at once: the pending spawn is dropped, so the program is never
/// reported busy and the next command never runs. The spawn's first busy
/// try kills the sentinel, the sign for the other task to abort; a spawn
/// that waited on the session's thread would have reported the program
/// busy and run the next command before the abort could be sent.
#[cfg(target_os = "linux")]
#[test]
fn an_abort_ends_a_run_whose_program_is_busy() {
	let dir = tempfile::tempdir().expect("the test's directory");
	if !busy_exec_refused(dir.path()) {
		say_not_run("an_abort_ends_a_run_whose_program_is_busy");
		return;
	}
	for kind in SESSION_PATHS {
		write_program(&dir.path().join(kind), "#!/bin/sh\nexit 7\n");
		let holder = Holder::new(&dir.path().join(kind));
		let mut sentinel = Sentinel::new();
		let after = dir.path().join(format!("{kind}.after"));
		let (chunks, said) = flume::unbounded();
		super::KILL_AT_BUSY_WAIT.set(sentinel.pid());
		let shell = crate::shell::Shell::new(None);
		let (ran, ()) = one_thread().block_on(async {
			let then = format!("echo after > {kind}.after");
			let run = shell.run(
				run_in(dir.path(), run_by(kind, kind, &then)),
				Some(chunks),
				crate::cancel::CancelToken::default(),
			);
			let abort = async {
				while !sentinel.died() {
					tokio::task::yield_now().await;
				}
				shell.abort().await;
			};
			tokio::join!(run, abort)
		});
		super::KILL_AT_BUSY_WAIT.set(0);
		drop(holder);
		let ran = ran.expect("the run");
		let (said, after_ran) = run_record(&said, &after);
		assert!(ran.cancelled, "{kind}: the abort ended the run: {ran:?}");
		assert!(!said.contains("Text file busy"), "{kind}: reported busy: {said:?}");
		assert!(!after_ran, "{kind}: the next command ran");
	}
}

/// A run's timeout that comes while the session's spawn waits for a busy
/// program ends the run there: the pending spawn is dropped, so the
/// program is never reported busy and the next command never runs. No
/// clock is compared: the timeout's timer (400 ms from before the run) is
/// armed before the spawn's last wait (512 ms, armed only once the waits
/// before it fired), so it fires first on the same runtime. A spawn that
/// waited on the session's thread would have reported the program busy
/// and run the next command before the timeout could act.
#[cfg(target_os = "linux")]
#[test]
fn a_timeout_ends_a_run_whose_program_is_busy() {
	let dir = tempfile::tempdir().expect("the test's directory");
	if !busy_exec_refused(dir.path()) {
		say_not_run("a_timeout_ends_a_run_whose_program_is_busy");
		return;
	}
	for kind in SESSION_PATHS {
		write_program(&dir.path().join(kind), "#!/bin/sh\nexit 7\n");
		let holder = Holder::new(&dir.path().join(kind));
		let after = dir.path().join(format!("{kind}.after"));
		let (chunks, said) = flume::unbounded();
		let then = format!("echo after > {kind}.after");
		// The token carries the run's timeout.
		let ran = one_thread().block_on(crate::shell::execute_shell(
			crate::shell::ShellExecuteOptions {
				command: run_by(kind, kind, &then),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				..Default::default()
			},
			Some(chunks),
			crate::cancel::CancelToken::new(Some(400)),
		));
		drop(holder);
		let ran = ran.expect("the run");
		let (said, after_ran) = run_record(&said, &after);
		assert!(ran.timed_out, "{kind}: the timeout ended the run: {ran:?}");
		assert!(!said.contains("Text file busy"), "{kind}: reported busy: {said:?}");
		assert!(!after_ran, "{kind}: the next command ran");
	}
}

/// The child of a deferred spawn that waits for a busy program holds none
/// of the host's other descriptors meanwhile: it closed what its exec would
/// close. Its first exec try reports the program busy (`FAKE_BUSY_EXECS`,
/// so the test runs on every kernel, gVisor's too), and at its first wait
/// the child stops itself (`STOP_AT_BUSY_WAIT`), so the test always reads
/// it while it waits: its descriptor table (each entry printed as an
/// `FDTABLE` line) must not hold a pipe of the host's, and the pipe reaches
/// end of file once the host closes its own end. Continued, the child's
/// next try runs the program.
#[cfg(target_os = "linux")]
#[test]
fn a_deferred_child_waiting_for_a_busy_program_holds_no_host_descriptor() {
	use std::io::Write as _;
	const TEST: &str = "a_deferred_child_waiting_for_a_busy_program_holds_no_host_descriptor";
	let dir = tempfile::tempdir().expect("the test's directory");
	let program = dir.path().join("deferred");
	let err = dir.path().join("deferred.err");
	write_program(&program, "#!/bin/sh\nexit 7\n");
	let (mut host_reads, host_writes) = std::io::pipe().expect("a pipe of the host's");
	let pipe = {
		use std::os::fd::AsRawFd as _;
		std::fs::read_link(format!("/proc/self/fd/{}", host_writes.as_raw_fd())).expect("the pipe")
	};
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = vec![BString::from(program.as_os_str().as_encoded_bytes())];
	super::FAKE_BUSY_EXECS.set(1);
	super::STOP_AT_BUSY_WAIT.set(true);
	let mut p = spawn_by(&s, "deferred", &a, &env, &err).expect("the deferred spawn");
	super::STOP_AT_BUSY_WAIT.set(false);
	super::FAKE_BUSY_EXECS.set(0);
	let pid = i32::try_from(p.pid()).unwrap();
	// The child's state letter (`/proc/PID/stat`, after its name in
	// parentheses): wait until it shows the stop it makes at its first wait.
	let state = loop {
		let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
		match stat
			.rsplit_once(") ")
			.and_then(|(_, rest)| rest.chars().next())
		{
			Some('R' | 'S' | 'D') => thread::yield_now(),
			other => break other,
		}
	};
	let entries = std::fs::read_dir(format!("/proc/{pid}/fd"))
		.into_iter()
		.flatten();
	let table: Vec<(String, std::path::PathBuf)> = entries
		.filter_map(|entry| {
			let entry = entry.ok()?;
			Some((
				entry.file_name().to_string_lossy().into_owned(),
				std::fs::read_link(entry.path()).ok()?,
			))
		})
		.collect();
	for (fd, target) in &table {
		let _ = writeln!(std::io::stderr(), "FDTABLE {TEST} {fd} -> {}", target.display());
	}
	let _ = p.signal(Signal::Cont);
	drop(host_writes);
	assert_eq!(state, Some('T'), "the child stopped at its first wait");
	assert!(!table.is_empty(), "the stopped child's descriptor table was read");
	assert!(
		table.iter().all(|(_, target)| *target != pipe),
		"the waiting child holds the host's pipe {pipe:?}: {table:?}"
	);
	let read = std::io::Read::read(&mut host_reads, &mut [0u8; 1]).expect("read the pipe");
	assert_eq!(read, 0, "nothing wrote to the pipe");
	let status = wait(&mut p);
	assert_eq!(status, ExitStatus::Exited(7), "the program ran at the next try");
}

/// `./name &`, then `rest`, on the session's spawn path `kind` (the
/// background job's external spawns as the foreground one would).
#[cfg(target_os = "linux")]
fn background_by(kind: &str, name: &str, rest: &str) -> String {
	match kind {
		"posix_spawn" => format!("./{name} & {rest}"),
		"fork" => {
			let other = if process_umask() == Some(0o077) {
				"027"
			} else {
				"077"
			};
			format!("umask {other}; ./{name} & {rest}")
		},
		_ => unreachable!("{kind}"),
	}
}

/// What a run prints until `want` appears in it, or until it ends.
#[cfg(target_os = "linux")]
async fn said_until(said: &flume::Receiver<String>, want: &str) -> String {
	let mut text = String::new();
	while !text.contains(want) {
		match said.recv_async().await {
			Ok(chunk) => text.push_str(&chunk),
			Err(_) => break,
		}
	}
	text
}

/// `prog & pid=$!` with a busy program: `$!` is known, and the script goes
/// on, before the program's tries end, as bash's forked child is `$!`
/// before its exec; only `wait $pid` waits for the tries. The test lets the
/// program go only once the command after `pid=$!` printed: a `$!` that
/// waited for the tries would have been known only once they ran out, the
/// program failing (126) while still held. `$!` names the program's own
/// process (the one that waited for it), as the program prints `$$`.
#[cfg(target_os = "linux")]
#[test]
fn a_background_jobs_pid_is_known_while_its_program_is_busy() {
	let dir = tempfile::tempdir().expect("the test's directory");
	if !busy_exec_refused(dir.path()) {
		say_not_run("a_background_jobs_pid_is_known_while_its_program_is_busy");
		return;
	}
	for kind in SESSION_PATHS {
		let program = dir.path().join(kind);
		let own = dir.path().join(format!("{kind}.pid"));
		write_program(&program, &format!("#!/bin/sh\necho $$ > {}\nexit 7\n", own.display()));
		let holder = Holder::new(&program);
		let (chunks, said) = flume::unbounded();
		let shell = crate::shell::Shell::new(None);
		let rest = "pid=$!; echo next $pid; wait $pid; echo status $?";
		let (ran, before) = one_thread().block_on(async {
			let run = shell.run(
				run_in(dir.path(), background_by(kind, kind, rest)),
				Some(chunks),
				crate::cancel::CancelToken::default(),
			);
			let other = async {
				let before = said_until(&said, "next ").await;
				drop(holder);
				before
			};
			tokio::join!(run, other)
		});
		let ran = ran.expect("the run");
		let text = before + &said.drain().collect::<String>();
		let bang = text
			.lines()
			.find_map(|line| line.strip_prefix("next "))
			.unwrap_or_default()
			.to_owned();
		assert!(
			text.contains("status 7"),
			"{kind}: the program ran once let go, after the next command: {text:?} {ran:?}"
		);
		let ran_as = std::fs::read_to_string(&own).unwrap_or_default();
		assert_eq!(ran_as.trim(), bang, "{kind}: $! is the program's own pid");
	}
}

/// A background job's program that stays busy fails as the same command
/// in the foreground does: the same message (bash's `bad interpreter` for a
/// `#!` script) and status 126, though the process that waited for it
/// prints them ([`crate::bash::OnBusy::Child`]).
#[cfg(target_os = "linux")]
#[test]
fn a_background_program_that_stays_busy_fails_as_in_the_foreground() {
	let dir = tempfile::tempdir().expect("the test's directory");
	if !busy_exec_refused(dir.path()) {
		say_not_run("a_background_program_that_stays_busy_fails_as_in_the_foreground");
		return;
	}
	let program = dir.path().join("held");
	write_program(&program, "#!/bin/sh\nexit 7\n");
	let holder = Holder::new(&program);
	let (chunks, said) = flume::unbounded();
	let shell = crate::shell::Shell::new(None);
	let command = "./held 2> bg.err & wait $!; echo bg $?; ./held 2> fg.err; echo fg $?".to_owned();
	let ran = one_thread().block_on(shell.run(
		run_in(dir.path(), command),
		Some(chunks),
		crate::cancel::CancelToken::default(),
	));
	drop(holder);
	let ran = ran.expect("the run");
	let text: String = said.drain().collect();
	let bg = std::fs::read_to_string(dir.path().join("bg.err")).unwrap_or_default();
	let fg = std::fs::read_to_string(dir.path().join("fg.err")).unwrap_or_default();
	assert!(text.contains("bg 126") && text.contains("fg 126"), "{text:?} {ran:?}");
	assert!(fg.contains("bad interpreter: Text file busy"), "foreground: {fg:?}");
	assert_eq!(bg, fg, "the background job's report");
}

/// A background job's busy program without `#!` (a possible shell text
/// file) is waited for before `$!` is known: once free, its exec fails
/// with `ENOEXEC`, and the engine runs it as a script, which a process
/// already returned as `$!` could not. The first wait lets the program go
/// (`KILL_AT_BUSY_WAIT`).
#[cfg(target_os = "linux")]
#[test]
fn a_busy_background_script_without_a_shebang_still_runs_as_a_script() {
	let dir = tempfile::tempdir().expect("the test's directory");
	if !busy_exec_refused(dir.path()) {
		say_not_run("a_busy_background_script_without_a_shebang_still_runs_as_a_script");
		return;
	}
	let program = dir.path().join("plain");
	write_program(&program, "exit 7\n");
	let holder = Holder::new(&program);
	let (chunks, said) = flume::unbounded();
	super::KILL_AT_BUSY_WAIT.set(holder.pid());
	let shell = crate::shell::Shell::new(None);
	let ran = one_thread().block_on(shell.run(
		run_in(dir.path(), "./plain & wait $!; echo status $?".to_owned()),
		Some(chunks),
		crate::cancel::CancelToken::default(),
	));
	super::KILL_AT_BUSY_WAIT.set(0);
	drop(holder);
	let ran = ran.expect("the run");
	let text: String = said.drain().collect();
	assert!(text.contains("status 7"), "{text:?} {ran:?}");
}

/// bash's forked child opens a background command's FIFO redirection: the
/// spawn returns (with the pid `$!` shows) while the open still waits for
/// the FIFO's other end, which the shell's next command opens.
#[test]
fn redirections_left_to_the_process_do_not_hold_the_spawn() {
	let fifo = temp_path("child-fifo");
	let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
	// SAFETY: mkfifo with a valid C path.
	assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo");
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh("echo $$");
	let mut sp = spec(&a, &env, NEW);
	sp.redirs = Some(ChildRedirs {
		list:      vec![child_open(&[1], &fifo, WRITE)],
		exec_diag: BString::from("test: /bin/sh: "),
	});
	// Returns although nothing reads the FIFO yet.
	let mut p = s.spawn(sp).expect("spawn");
	let said = std::fs::read_to_string(&fifo).expect("read the FIFO");
	assert_eq!(said.trim(), p.pid().to_string(), "the program's own pid");
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	std::fs::remove_file(&fifo).unwrap();
}

/// A redirection or exec the process fails reports as bash's child does:
/// the message on its (redirected) stderr, status 1 or 127.
#[test]
fn failures_left_to_the_process_are_its_own_message_and_status() {
	let err = temp_path("child-err");
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh("echo never");
	let mut sp = spec(&a, &env, NEW);
	let missing = std::path::Path::new("/nonexistent/dir/f");
	sp.redirs = Some(ChildRedirs {
		list:      vec![child_open(&[2], &err, WRITE), child_open(&[1], missing, WRITE)],
		exec_diag: BString::from("test: /bin/sh: "),
	});
	let mut p = s.spawn(sp).expect("spawn");
	assert_eq!(wait(&mut p), ExitStatus::Exited(1));
	assert_eq!(
		std::fs::read_to_string(&err).unwrap(),
		"test: /nonexistent/dir/f: No such file or directory\n"
	);

	let a = argv(&["/nonexistent/prog"]);
	let mut sp = spec(&a, &env, NEW);
	sp.redirs = Some(ChildRedirs {
		list:      vec![child_open(&[2], &err, WRITE)],
		exec_diag: BString::from("test: /nonexistent/prog: "),
	});
	let mut p = s.spawn(sp).expect("the spawn does not wait for the exec");
	assert_eq!(wait(&mut p), ExitStatus::Exited(127));
	assert_eq!(
		std::fs::read_to_string(&err).unwrap(),
		"test: /nonexistent/prog: No such file or directory\n"
	);
	std::fs::remove_file(&err).unwrap();
}

/// A process whose redirection open waits (a FIFO with no other end) holds
/// none of the host's close-on-exec descriptors meanwhile: a pipe's reader
/// in the host gets end of file once the host closes the write end (here
/// close-on-exec at fd 100 or above, as a pump's end is), while the open
/// still waits. bash's child holds none either. `sweep` is where the child's
/// sweep starts ([`Sweep`]): the counting loop must reach past fd 16, and
/// the walk must find an fd wherever it is.
fn waiting_open_holds_no_host_descriptor(sweep: Sweep) {
	use std::{
		io::Read,
		os::fd::{AsRawFd, FromRawFd, OwnedFd},
	};

	/// A wait that only names a hang: the end of file comes at once, or
	/// never while the open waits.
	const HANG: Duration = Duration::from_secs(60);
	let fifo = temp_path(&format!("held-fifo-{sweep:?}"));
	let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
	// SAFETY: mkfifo with a valid C path.
	assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo");
	let (mut reader, writer) = std::io::pipe().unwrap();
	// SAFETY: F_DUPFD_CLOEXEC on a descriptor this test owns makes a new one.
	let high = unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 100) };
	assert!(high >= 100, "F_DUPFD_CLOEXEC: {}", io::Error::last_os_error());
	// SAFETY: `high` is a new descriptor nothing else owns.
	let high = unsafe { OwnedFd::from_raw_fd(high) };
	drop(writer);
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = argv(&["/bin/true"]);
	let mut sp = spec(&a, &env, NEW);
	sp.redirs = Some(ChildRedirs {
		list:      vec![child_open(&[0], &fifo, OpenFlags::READ)],
		exec_diag: BString::from("test: /bin/true: "),
	});
	super::force_sweep(sweep);
	let spawned = s.spawn(sp);
	super::force_sweep(Sweep::CloseRange);
	let mut p = spawned.expect("spawn");
	drop(high);
	let (tx, eof) = std::sync::mpsc::channel();
	thread::spawn(move || {
		let mut rest = Vec::new();
		let _ = tx.send(reader.read_to_end(&mut rest).map(|_| rest));
	});
	// Another test's child holds a copy of the write end only until its exec.
	let got = eof.recv_timeout(HANG);
	// Let the open go in any case.
	drop(std::fs::OpenOptions::new().write(true).open(&fifo).unwrap());
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	std::fs::remove_file(&fifo).unwrap();
	assert!(
		matches!(&got, Ok(Ok(rest)) if rest.is_empty()),
		"the reader got no end of file while the open waited: the child held its write end \
		 ({sweep:?})"
	);
}

#[test]
fn a_waiting_redirection_open_holds_no_host_descriptor() {
	waiting_open_holds_no_host_descriptor(Sweep::CloseRange);
}

/// Where `close_range` is refused (a kernel before 5.9, a seccomp profile),
/// the child walks `/proc/self/fd`.
#[cfg(any(target_os = "linux", target_os = "android"))]
#[test]
fn a_waiting_redirection_open_holds_no_host_descriptor_without_close_range() {
	waiting_open_holds_no_host_descriptor(Sweep::Walk);
}

/// Where no descriptor list can be read either (no `/proc`), the child
/// closes every number below the descriptor limit.
#[test]
fn a_waiting_redirection_open_holds_no_host_descriptor_without_a_list() {
	waiting_open_holds_no_host_descriptor(Sweep::Count);
}

/// The host's descriptor without close-on-exec is listed before the fork
/// as one the child keeps. If another thread closes it and a new
/// close-on-exec descriptor takes its number before the fork (here a
/// pipe's write end, as another job's), the child must not keep that
/// number: the pipe's reader gets end of file once the host closes the
/// write end, while the child's open still waits.
#[test]
fn a_number_reused_between_the_list_and_the_fork_is_not_kept() {
	use std::{
		io::Read,
		os::fd::{AsRawFd, FromRawFd, OwnedFd},
	};

	/// A wait that only names a hang: the end of file comes at once, or
	/// never while the open waits.
	const HANG: Duration = Duration::from_secs(60);
	let fifo = temp_path("reused-fifo");
	let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
	// SAFETY: mkfifo with a valid C path.
	assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo");
	let null = std::fs::File::open("/dev/null").unwrap();
	// SAFETY: F_DUPFD on a descriptor this test owns makes a new one, without
	// close-on-exec.
	let n = unsafe { libc::fcntl(null.as_raw_fd(), libc::F_DUPFD, 200) };
	assert!(n >= 200, "F_DUPFD: {}", io::Error::last_os_error());
	drop(null);
	let (mut reader, writer) = std::io::pipe().unwrap();
	let w = writer.as_raw_fd();
	// After the list, before the fork: number `n` becomes a copy of the
	// pipe's write end, with close-on-exec.
	super::before_fork(move || {
		// SAFETY: dup2 replaces this test's own descriptor `n`; F_SETFD only
		// sets its flags.
		unsafe {
			assert_eq!(libc::dup2(w, n), n, "dup2: {}", io::Error::last_os_error());
			assert_eq!(libc::fcntl(n, libc::F_SETFD, libc::FD_CLOEXEC), 0, "F_SETFD");
		}
	});
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = argv(&["/bin/true"]);
	let mut sp = spec(&a, &env, NEW);
	sp.redirs = Some(ChildRedirs {
		list:      vec![child_open(&[0], &fifo, OpenFlags::READ)],
		exec_diag: BString::from("test: /bin/true: "),
	});
	let mut p = s.spawn(sp).expect("spawn");
	// SAFETY: `n` is this test's copy of the write end now, owned here.
	drop(unsafe { OwnedFd::from_raw_fd(n) });
	drop(writer);
	let (tx, eof) = std::sync::mpsc::channel();
	thread::spawn(move || {
		let mut rest = Vec::new();
		let _ = tx.send(reader.read_to_end(&mut rest).map(|_| rest));
	});
	// Another test's child holds a copy of the write end only until its exec.
	let got = eof.recv_timeout(HANG);
	// Let the open go in any case.
	drop(std::fs::OpenOptions::new().write(true).open(&fifo).unwrap());
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	std::fs::remove_file(&fifo).unwrap();
	assert!(
		matches!(&got, Ok(Ok(rest)) if rest.is_empty()),
		"the reader got no end of file while the open waited: the child kept fd {n}, which a \
		 close-on-exec descriptor took before the fork"
	);
}

/// A step the engine found bad ([`ChildRedir::Fail`]) ends the process in
/// its place: the steps before it are applied (its message goes to the file
/// one of them opened as fd 2), none after it is, and the status is 1.
#[test]
fn a_failed_step_ends_the_process_after_the_steps_before_it() {
	let err = temp_path("fail-err");
	let after = temp_path("fail-after");
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh("echo never");
	let mut sp = spec(&a, &env, NEW);
	let text = "test: line 1: 9: Bad file descriptor\n";
	sp.redirs = Some(ChildRedirs {
		list:      vec![
			child_open(&[2], &err, WRITE),
			ChildRedir::Fail { text: BString::from(text) },
			child_open(&[1], &after, WRITE),
		],
		exec_diag: BString::from("test: /bin/sh: "),
	});
	let mut p = s.spawn(sp).expect("spawn");
	assert_eq!(wait(&mut p), ExitStatus::Exited(1));
	assert_eq!(std::fs::read_to_string(&err).unwrap(), text);
	assert!(!after.exists(), "a step after the failed one was applied");
	std::fs::remove_file(&err).unwrap();
}

/// A process that applies its own redirections keeps the host's descriptors
/// without close-on-exec, as bash's children and this spawner's other paths
/// (`posix_spawn`, fork+exec) do: an embedded host leaves the descriptors it
/// inherited open so (`process::host::inherited_fds`), a make jobserver's
/// pipe among them.
///
/// Two strays, so a sweep of part of the range shows: `high`, the lowest
/// free fd from 10 up, where a shell keeps the copies of the fds a
/// redirection of a compound command replaces (dash copies stdout to fd 10
/// for `if …; fi > out`); and `low`, the lowest free fd from 3 up, below 10
/// in a run alone, where dash keeps nothing (its copies go to 10 and up).
/// The probe redirects with `exec`, which keeps no copy and closes the fd it
/// opened for the file before the checks, so only a stray can answer to
/// either number.
#[test]
fn a_process_that_applies_its_redirections_keeps_the_hosts_inherited_fds() {
	use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

	let out = temp_path("stray-out");
	let err = temp_path("stray-err");
	let (pipe_read, _writer) = std::io::pipe().unwrap();
	// A new descriptor of `pipe_read`'s pipe, the lowest free from `from` up,
	// not close-on-exec.
	let stray = |from: i32| {
		// SAFETY: F_DUPFD on a descriptor this test owns makes a new one.
		let n = unsafe { libc::fcntl(pipe_read.as_raw_fd(), libc::F_DUPFD, from) };
		assert!(n >= from, "F_DUPFD: {}", io::Error::last_os_error());
		// SAFETY: `n` is a new descriptor nothing else owns.
		unsafe { OwnedFd::from_raw_fd(n) }
	};
	let high_fd = stray(10);
	let low_fd = stray(3);
	drop(pipe_read);
	let (high, low) = (high_fd.as_raw_fd(), low_fd.as_raw_fd());
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh(&format!(
		"exec > '{}'; for n in {high} {low}; do if [ -e /dev/fd/$n ]; then echo has; else echo \
		 none; fi; done",
		out.display()
	));
	for sweep in [Sweep::CloseRange, Sweep::Walk, Sweep::Count] {
		let mut deferred = spec(&a, &env, NEW);
		deferred.redirs = Some(ChildRedirs {
			list:      vec![child_open(&[2], &err, WRITE)],
			exec_diag: BString::from("test: /bin/sh: "),
		});
		super::force_sweep(sweep);
		let spawned = s.spawn(deferred);
		super::force_sweep(Sweep::CloseRange);
		let mut p = spawned.expect("spawn");
		assert_eq!(wait(&mut p), ExitStatus::Exited(0));
		assert_eq!(
			std::fs::read_to_string(&out).unwrap(),
			"has\nhas\n",
			"an inherited fd did not reach the process (fds {high} then {low}, {sweep:?})"
		);
	}
	let mut p = s.spawn(spec(&a, &env, NEW)).expect("spawn");
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	let other = std::fs::read_to_string(&out).unwrap();
	// macOS's posix_spawn path closes every descriptor it does not place
	// (POSIX_SPAWN_CLOEXEC_DEFAULT).
	#[cfg(target_os = "linux")]
	assert_eq!(other, "has\nhas\n", "the other paths pass the strays on (fds {high} then {low})");
	#[cfg(not(target_os = "linux"))]
	let _ = other;
	drop((high_fd, low_fd));
	std::fs::remove_file(&out).unwrap();
	std::fs::remove_file(&err).unwrap();
}

#[test]
fn detached_externals_lead_their_own_sessions_without_a_terminal() {
	let env = EnvView::default();
	let s = spawner(Sessions::Detach, Duration::from_secs(2));
	let a = argv(&["/bin/sleep", "30"]);
	let mut lead = s.spawn(spec(&a, &env, NEW)).unwrap();
	let lead_pid = lead.pid();
	assert_eq!((pgid(lead_pid), sid(lead_pid)), (lead_pid as i32, lead_pid as i32));
	// pi-shell lesson (shell.rs ~6105): a later stage must not setpgid-join a
	// leader that moved sessions; detached stages lead their own.
	let mut stage = s.spawn(spec(&a, &env, PgroupSpec::Join(lead_pid))).unwrap();
	let pid = stage.pid();
	assert_eq!((pgid(pid), sid(pid)), (pid as i32, pid as i32));
	for p in [&mut lead, &mut stage] {
		p.signal(Signal::Kill).unwrap();
		assert_eq!(wait(p), ExitStatus::Signaled(Signal::Kill));
	}
}

/// pi-shell lesson (shell.rs ~6105/~7827): joining a group whose leader is
/// in another session fails with EPERM; the spawner must not try, and the
/// stage leads its own group in our session instead.
#[test]
fn share_join_of_a_leader_in_another_session_leads_its_own_group() {
	let mut foreign = std::process::Command::new("/bin/sleep");
	foreign.arg("30");
	// SAFETY: setsid is async-signal-safe.
	unsafe {
		foreign.pre_exec(|| {
			libc::setsid();
			Ok(())
		});
	}
	let mut foreign = foreign.spawn().unwrap();
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_secs(2));
	let a = argv(&["/bin/sleep", "30"]);
	let mut p = s
		.spawn(spec(&a, &env, PgroupSpec::Join(foreign.id())))
		.unwrap();
	let pid = p.pid();
	assert_eq!(pgid(pid), pid as i32, "leads its own group");
	assert_eq!(sid(pid), our_sid(), "stays in our session");
	p.signal(Signal::Kill).unwrap();
	wait(&mut p);
	foreign.kill().unwrap();
	foreign.wait().unwrap();
}

#[test]
fn share_join_of_an_exited_but_held_leader_joins_its_group() {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_secs(2));
	let a = argv(&["/usr/bin/true"]);
	let mut lead = s.spawn(spec(&a, &env, NEW)).unwrap();
	assert_eq!(wait(&mut lead), ExitStatus::Exited(0));
	// `true | sleep`: the leader exited first, but its ExtProc is alive, so
	// it is an unreaped zombie and the group still exists.
	let b = argv(&["/bin/sleep", "30"]);
	let mut stage = s
		.spawn(spec(&b, &env, PgroupSpec::Join(lead.pid())))
		.unwrap();
	assert_eq!(pgid(stage.pid()), lead.pid() as i32, "joined the leader's group");
	stage.signal(Signal::Kill).unwrap();
	wait(&mut stage);
	drop(lead);
}

#[test]
fn share_join_after_the_leader_was_reaped_leads_its_own_group() {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_secs(2));
	let a = argv(&["/usr/bin/true"]);
	let mut lead = s.spawn(spec(&a, &env, NEW)).unwrap();
	wait(&mut lead);
	let gone = lead.pid();
	drop(lead);
	let b = argv(&["/bin/sleep", "30"]);
	let mut stage = s.spawn(spec(&b, &env, PgroupSpec::Join(gone))).unwrap();
	assert_eq!(pgid(stage.pid()), stage.pid() as i32);
	stage.signal(Signal::Kill).unwrap();
	wait(&mut stage);
}

/// Running or sleeping (not stopped, not a zombie, not gone).
fn live(pid: i32) -> bool {
	proc::info(pid).is_some_and(|i| !matches!(i.state, ProcState::Zombie | ProcState::Stopped))
}

/// The first child of `parent` (the scan sees it once it has forked).
fn child_of(parent: i32) -> proc::ProcInfo {
	let mut found = None;
	until("grandchild forked", || {
		found = proc::list().unwrap().into_iter().find(|p| p.ppid == parent);
		found.is_some()
	});
	found.unwrap()
}

/// Non-interactive bash layout: the child shares the host's group and
/// session (so it keeps the controlling terminal), `PgroupSpec` is ignored,
/// and signals, stop and cont reach the child alone, never the shared group.
///
/// The host is a process of its own, in a process group of its own: this
/// test stops a child in the host's group, and a group with a stopped member
/// is one the kernel may hang up. gVisor before 553528ee ("Only signal a
/// process group's stopped members when it becomes orphaned") sends SIGHUP
/// and SIGCONT to every member of an orphaned group with a stopped member
/// each time any member leaves it; the test binary's own group is orphaned
/// when it runs under `setsid`, and other tests' children leave it all the
/// time, so the binary died of SIGHUP. In a group of its own, whose parent is
/// in another group of the same session, the group is not orphaned and holds
/// no other test's children.
#[test]
fn inherit_keeps_the_hosts_group_and_signals_only_the_child() {
	const NAME: &str =
		"sys::spawn::unix::tests::inherit_keeps_the_hosts_group_and_signals_only_the_child";
	const ALONE: &str = "PI_SHELL_TEST_ALONE";
	if std::env::var_os(ALONE).is_none_or(|name| name != NAME) {
		let (status, out, err) = run_alone(NAME, ALONE, Duration::from_secs(60));
		let (out, err) = (String::from_utf8_lossy(&out), String::from_utf8_lossy(&err));
		let Some(status) = status else {
			panic!("the run of its own did not end within 60 s; its group was killed:\n{out}\n{err}");
		};
		assert!(status.success(), "the run of its own failed ({status}):\n{out}\n{err}");
		assert!(out.contains("1 passed"), "the run of its own ran no test:\n{out}\n{err}");
		return;
	}
	assert_eq!(pgid(0), std::process::id() as i32, "the host leads a group of its own");
	let env = EnvView::default();
	let s = spawner(Sessions::Inherit, Duration::from_secs(2));
	let sleep = crate::testkit::child::on_path("sleep");
	let a = sh(&format!("{sleep} 30 & wait"));
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid();
	assert_eq!((pgid(pid), sid(pid)), (pgid(0), our_sid()), "host's group and session");
	let grandchild = child_of(pid as i32);
	let b = argv(&[sleep.as_str(), "30"]);
	let mut joined = s.spawn(spec(&b, &env, PgroupSpec::Join(pid))).unwrap();
	assert_eq!(pgid(joined.pid()), pgid(0), "Join is ignored too");
	joined.signal(Signal::Kill).unwrap();
	assert_eq!(wait(&mut joined), ExitStatus::Signaled(Signal::Kill));
	assert!(live(pid as i32), "a signal to one external spares its siblings");

	p.stop().unwrap();
	until("child stopped", || proc::info(pid as i32).is_some_and(|i| i.state == ProcState::Stopped));
	assert!(live(grandchild.pid), "stop reaches the child only");
	p.cont().unwrap();
	until("child continued", || live(pid as i32));
	p.signal(Signal::Kill).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Kill));
	assert!(live(grandchild.pid), "the grandchild is outside the child's scope");
	assert!(proc::signal_pinned(&grandchild, Signal::Kill).unwrap());
	until("grandchild gone", || proc::ended(grandchild.pid));
}

/// Run this binary's test `name` alone (`--exact`, the marker `alone` set to
/// it), in a process group of its own, for up to `bound`: its exit status
/// (`None` past `bound`, when its whole group is killed) and what it wrote to
/// stdout and stderr so far. The pipes are read on threads of their own, so
/// a full pipe cannot stop the run, and output a process outside its group
/// keeps open cannot keep this waiting.
fn run_alone(
	name: &str,
	alone: &str,
	bound: Duration,
) -> (Option<std::process::ExitStatus>, Vec<u8>, Vec<u8>) {
	use std::{io::Read, process::Stdio, time::Instant};
	fn reader(
		mut pipe: impl Read + Send + 'static,
	) -> (Arc<Mutex<Vec<u8>>>, thread::JoinHandle<()>) {
		let got = Arc::new(Mutex::new(Vec::new()));
		let into = Arc::clone(&got);
		let thread = thread::spawn(move || {
			let mut buf = [0u8; 4096];
			while let Ok(n @ 1..) = pipe.read(&mut buf) {
				into.lock().extend_from_slice(&buf[..n]);
			}
		});
		(got, thread)
	}
	let mut child = std::process::Command::new(std::env::current_exe().unwrap())
		.args(["--exact", name, "--nocapture", "--test-threads=1"])
		.env(alone, name)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.process_group(0)
		.spawn()
		.unwrap();
	let group = i32::try_from(child.id()).unwrap();
	let (out, out_thread) = reader(child.stdout.take().unwrap());
	let (err, err_thread) = reader(child.stderr.take().unwrap());
	let deadline = Instant::now() + bound;
	let status = loop {
		if let Some(status) = child.try_wait().unwrap() {
			break Some(status);
		}
		if Instant::now() >= deadline {
			// SAFETY: kill takes integer ids; the group is the run's own.
			unsafe { libc::kill(-group, libc::SIGKILL) };
			child.wait().unwrap();
			break None;
		}
		thread::sleep(Duration::from_millis(10));
	};
	// The pipes close once every process of the run's group is gone; give
	// the readers a moment for the last bytes, never a wait without end.
	let drained = Instant::now() + Duration::from_secs(5);
	while !(out_thread.is_finished() && err_thread.is_finished()) && Instant::now() < drained {
		thread::sleep(Duration::from_millis(10));
	}
	let (out, err) = (out.lock().clone(), err.lock().clone());
	(status, out, err)
}

/// A child of the test, killed when dropped (also when the test fails).
struct Bystander(std::process::Child);

impl Drop for Bystander {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}

/// The abandon escalation (TERM, KILL after the grace) targets the child's
/// pid: a process sharing the host's group survives it. The `sleep`s never
/// end by themselves while the test runs, however slow the host.
#[test]
fn inherit_abandon_escalation_spares_the_hosts_group() {
	let grace = Duration::from_millis(300);
	let env = EnvView::default();
	let s = spawner(Sessions::Inherit, grace);
	let mut bystander = Bystander(
		crate::testkit::child::dies_with_this_process(std::process::Command::new("sleep").arg("600"))
			.spawn()
			.unwrap(),
	);
	assert_eq!(pgid(bystander.0.id()), pgid(0));
	// `exec` keeps the ignored TERM: one process that only KILL ends.
	let a = sh(&format!("trap '' TERM; exec {} 600", crate::testkit::child::on_path("sleep")));
	let p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid() as i32;
	until("exec'd", || proc::info(pid).is_some_and(|i| i.name == "sleep"));
	let child = proc::info(pid).expect("the child runs");
	drop(p);
	// TERM is ignored: the child still ran when KILL was due, and KILL went
	// to its pid.
	assert_killed_after(&escalated(&s), grace, std::slice::from_ref(&child));
	until("child killed", || proc::ended(pid));
	assert!(
		bystander.0.try_wait().unwrap().is_none(),
		"nothing was sent to the host's process group"
	);
}

/// Reaping retires a process-only leak scope before its pid can be reused.
#[test]
fn reaping_retires_inherited_process_scope() {
	let env = EnvView::default();
	let s = spawner(Sessions::Inherit, Duration::from_secs(2));
	let a = sh("exit 0");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let scope = Scope::Process { pid: p.pid() as i32 };
	assert!(s.shared.state.groups.lock().list.contains(&scope));
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	// A live ExtProc still pins the zombie's identity for signals.
	assert!(s.shared.state.groups.lock().list.contains(&scope));
	drop(p);
	assert!(!s.shared.state.groups.lock().list.contains(&scope));
}

#[test]
fn inherit_leftovers_track_the_child_itself() {
	let env = EnvView::default();
	let s = spawner(Sessions::Inherit, Duration::from_secs(2));
	let a = argv(&["/bin/sleep", "30"]);
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid();
	let left = s.leftovers().unwrap();
	assert_eq!(left.len(), 1, "{left:?}");
	assert_eq!((left[0].pid, left[0].group), (pid, pid), "the pid is its own scope");
	p.signal(Signal::Kill).unwrap();
	wait(&mut p);
	drop(p);
	assert!(s.leftovers().unwrap().is_empty(), "the test process itself is never listed");
}

#[test]
fn stop_and_cont_reach_every_member_of_the_group() {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_secs(2));
	let a = sh("/bin/sleep 30 & /bin/sleep 30 & wait");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let group = p.pid() as i32;
	// Both sleeps run `sleep` before the stop: gVisor's `execve` discards a
	// stop signal still pending when it replaces the image (Linux keeps it),
	// so a member stopped during its exec would run on.
	until("three members, both sleeps exec'd", || {
		let members = live_group(group);
		members.len() == 3 && members.iter().filter(|m| m.name == "sleep").count() == 2
	});
	p.stop().unwrap();
	until("all stopped", || {
		live_group(group)
			.iter()
			.all(|m| m.state == ProcState::Stopped)
	});
	p.cont().unwrap();
	until("all continued", || {
		live_group(group)
			.iter()
			.all(|m| m.state != ProcState::Stopped)
	});
	p.signal(Signal::Kill).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Kill));
	until("group gone", || live_group(group).is_empty());
}

/// Cancel of a running external: TERM to the group at once, KILL after the
/// grace, as the escalation recorded it (not how long the group took to go,
/// which a busy host stretches).
fn abandon_escalates(grace: Duration) {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, grace);
	// The trap makes sh and the sleep it starts ignore TERM.
	let a = sh(&format!("trap '' TERM; {} 600; exit 0", crate::testkit::child::on_path("sleep")));
	let p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let group = p.pid() as i32;
	let mut members = Vec::new();
	until("sleep started", || {
		members = live_group(group);
		members.len() == 2
	});
	drop(p);
	// Both still ran when KILL was due; KILL went to the group.
	let after = assert_killed_after(&escalated(&s), grace, &members);
	until("group killed", || live_group(group).is_empty());
	eprintln!("TERM→KILL escalation: grace {grace:?}, KILL step {after:?} after the drop");
}

/// A detached external (`nohup`) dropped while it runs is released, not
/// abandoned: no TERM, no KILL after the grace, no leftover; it is reaped
/// once it exits.
#[test]
fn dropped_detached_external_runs_on_and_is_no_leftover() {
	let env = EnvView::default();
	let s = spawner(Sessions::Detach, Duration::from_millis(100));
	let sleep = crate::testkit::child::on_path("sleep");
	let a = argv(&[sleep.as_str(), "30"]);
	let mut detached = spec(&a, &env, NEW);
	detached.lineage = crate::bash::Lineage { label: 7, detached: true };
	let p = s.spawn(detached).unwrap();
	let pid = p.pid() as i32;
	assert!(s.leftovers().unwrap().is_empty(), "a detached external is no leak");
	drop(p);
	assert!(s.escalations().is_empty(), "released, not abandoned: no escalation started");
	assert!(live(pid), "released, not killed");
	// SAFETY: plain syscall; the pid is unreaped while the sleep runs.
	assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
	until("reaped after its exit", || !proc::exists(pid));
}

/// The shell tears down while a detached external runs: its `ExtProc` is
/// dropped, but what it writes after that still reaches the engine object,
/// as a pipe would carry it, and its end of file completes the work. With no
/// runtime, the retained output work advances whenever anyone polls it:
/// here a drive loop before it parks (as a `Parker` does).
#[test]
fn output_written_after_the_extproc_is_dropped_still_arrives() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let out = MemFile::default();
	let a = sh("/bin/sleep 0.3; echo late");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	sp.lineage = crate::bash::Lineage { label: 0, detached: true };
	drop(s.spawn(sp).unwrap());
	let waker = Waker::from(Arc::new(Unpark(thread::current())));
	let cx = Context::from_waker(&waker);
	let mut key = crate::sys::WaitKey::default();
	while out.captured() != b"late\n" {
		NativeSpawner::poll_orphans(&cx, &mut key);
		thread::park_timeout(Duration::from_millis(50));
	}
}

#[test]
fn abandoned_external_is_killed_after_a_short_grace() {
	abandon_escalates(Duration::from_millis(300));
}

#[test]
fn abandoned_external_is_killed_after_the_default_grace() {
	abandon_escalates(SpawnConfig::DEFAULT_GRACE);
}

#[test]
fn abandon_sends_term_to_the_whole_group_at_once() {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_secs(60));
	let sleep = crate::testkit::child::on_path("sleep");
	let a = sh(&format!("{sleep} 600 & {sleep} 600 & wait"));
	let p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let group = p.pid() as i32;
	until("members up", || live_group(group).len() == 3);
	drop(p);
	until("group terminated", || live_group(group).is_empty());
	// TERM ended the whole group: the escalation's KILL step, due a minute
	// after the drop, had not run when it was gone.
	let all = s.escalations();
	assert!(all.len() == 1 && all[0].running && all[0].fired.is_none(), "{all:?}");
}

#[test]
fn abandoning_a_paused_job_still_terminates_it() {
	let env = EnvView::default();
	let s = spawner(Sessions::Detach, Duration::from_secs(60));
	let sleep = crate::testkit::child::on_path("sleep");
	let a = argv(&[sleep.as_str(), "30"]);
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid() as i32;
	p.stop().unwrap();
	until("stopped", || proc::info(pid).is_some_and(|i| i.state == ProcState::Stopped));
	drop(p);
	until("terminated", || proc::ended(pid));
}

#[test]
fn a_scripts_term_does_not_escalate() {
	let env = EnvView::default();
	let s = spawner(Sessions::Detach, Duration::from_millis(100));
	// `cat` reads the test's gate to end of file: the script ends with a killed
	// test, where a loop of sleeps that ignores TERM would live on. The `:`
	// keeps `sh` from running `cat` in its own place.
	let gate = crate::testkit::child::Gate::new();
	let a = sh("trap '' TERM; /bin/cat; :");
	let mut sp = spec(&a, &env, NEW);
	let gate_reader = gate.reader();
	sp.stdio[0] = StdioSpec::Inherit(OsHandle(u64::try_from(gate_reader.as_raw_fd()).unwrap()));
	let mut p = s.spawn(sp).unwrap();
	let pid = p.pid() as i32;
	// `cat` is forked after the trap is set: TERM is ignored now.
	until("trap set", || {
		proc::session_members(pid)
			.unwrap()
			.iter()
			.filter(|m| m.state != ProcState::Zombie)
			.count()
			>= 2
	});
	p.signal(Signal::Term).unwrap();
	thread::sleep(Duration::from_millis(500));
	assert!(
		proc::info(pid).is_some_and(|i| i.state != ProcState::Zombie),
		"`kill -TERM` alone never kills"
	);
	p.signal(Signal::Kill).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Kill));
}

#[test]
fn output_is_delivered_before_completion() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let (out, err) = (MemFile::default(), MemFile::default());
	let a = sh("printf hello; printf oops >&2; exit 4");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, out.boxed(), err.boxed()];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(4));
	assert_eq!(out.captured(), b"hello", "complete as soon as the command is");
	assert_eq!(err.captured(), b"oops");
}

/// An engine pipe that is full until opened: writes stay `Pending`.
#[derive(Clone, Default)]
struct Gate {
	open:   Arc<Mutex<(bool, Option<Waker>)>>,
	output: Arc<Mutex<Vec<u8>>>,
}

impl File for Gate {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Ok(0))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		let mut g = self.open.lock();
		if !g.0 {
			g.1 = Some(cx.waker().clone());
			return Poll::Pending;
		}
		self.output.lock().extend_from_slice(buf);
		Poll::Ready(Ok(buf.len()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

#[test]
fn exit_is_not_reported_before_the_output_reaches_the_engine() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let gate = Gate::default();
	let a = sh("printf hello");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, StdioSpec::File(Box::new(gate.clone())), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	let pid = p.pid() as i32;
	until("child exited", || proc::info(pid).is_some_and(|i| i.state == ProcState::Zombie));
	let waker = Waker::from(Arc::new(Unpark(thread::current())));
	let mut cx = Context::from_waker(&waker);
	thread::sleep(Duration::from_millis(200));
	assert!(p.poll_wait(&mut cx).is_pending(), "the pump still holds the output");
	let pump = {
		let mut g = gate.open.lock();
		g.0 = true;
		g.1.take().expect("the pump waits on the full pipe")
	};
	pump.wake();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(*gate.output.lock(), b"hello");
}

#[test]
fn input_pump_feeds_stdin_until_end_of_file() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
	let out = MemFile::default();
	let a = argv(&["/bin/cat"]);
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [MemFile::feed(&data).boxed(), out.boxed(), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured(), data, "every byte crosses both pumps, then EOF");
}

/// An engine sink that is full (`Pending`, waking its writer at once) every
/// other write and takes at most 1000 bytes otherwise.
#[derive(Clone, Default)]
struct Trickle {
	full:   Arc<std::sync::atomic::AtomicBool>,
	output: Arc<Mutex<Vec<u8>>>,
}

impl File for Trickle {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Ok(0))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		if self
			.full
			.fetch_xor(true, std::sync::atomic::Ordering::SeqCst)
		{
			cx.waker().wake_by_ref();
			return Poll::Pending;
		}
		let n = buf.len().min(1000);
		self.output.lock().extend_from_slice(&buf[..n]);
		Poll::Ready(Ok(n))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

/// Megabytes of output through partial writes and a sink that keeps
/// filling up: the output pump holds the child back (its pipe fills) and
/// delivers every byte in order before the exit is reported.
#[test]
fn large_output_crosses_a_slow_engine_sink_intact() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let sink = Trickle::default();
	let a = argv(&["/usr/bin/seq", "1", "200000"]);
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, StdioSpec::File(Box::new(sink.clone())), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	let expected = (1..=200_000).fold(String::new(), |mut all, i| {
		use std::fmt::Write as _;
		let _ = writeln!(all, "{i}");
		all
	});
	assert!(*sink.output.lock() == expected.as_bytes(), "output lost, doubled or reordered");
}

/// An engine source that never has bytes (and never wakes anyone); counts
/// its live copies.
#[derive(Clone, Default)]
struct Silent(Arc<()>);

impl File for Silent {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Poll::Pending
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

/// Input waiting for engine bytes that never come stops with the child:
/// at its exit (the cancel wakes the poller, which drops the input pump
/// and the engine object before reporting the exit), and when the `ExtProc`
/// of a running child is dropped.
#[test]
fn input_waiting_for_engine_bytes_is_dropped_with_the_child() {
	let env = EnvView::default();
	let s = NativeSpawner::new(SpawnConfig {
		grace: Duration::from_millis(300),
		..SpawnConfig::default()
	});
	let silent = Silent::default();
	let a = sh("exit 3");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::File(Box::new(silent.clone())), StdioSpec::Null, StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(3));
	assert_eq!(Arc::strong_count(&silent.0), 1, "the exit released the engine object");
	drop(p);

	let a = argv(&["/bin/sleep", "30"]);
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::File(Box::new(silent.clone())), StdioSpec::Null, StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	let waker = Waker::from(Arc::new(Unpark(thread::current())));
	assert!(p.poll_wait(&mut Context::from_waker(&waker)).is_pending());
	assert_eq!(Arc::strong_count(&silent.0), 2, "the input pump waits on the engine object");
	drop(p);
	assert_eq!(Arc::strong_count(&silent.0), 1, "the drop released it at once");
	until("the abandoned child is gone", || s.leftovers().unwrap().is_empty());
}

/// A waker that counts its wakes and unparks the test's thread.
struct Wakes {
	count:  std::sync::atomic::AtomicUsize,
	thread: thread::Thread,
}

impl Wake for Wakes {
	fn wake(self: Arc<Self>) {
		self.wake_by_ref();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		self.count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
		self.thread.unpark();
	}
}

/// A host file without an OS handle that hands the child one line; at its
/// next read it waits until the poller's waker was woken twice, then has
/// nothing. The two wakes are the waiter thread's report of the child's
/// exit: `Tracker::exited` cancels the input pumps, then records the exit,
/// waking the poller each time. So the exit is recorded while the poll of
/// the pumps that read the cancel still runs, in every run: the child
/// cannot exit before it has the line, which comes after that read.
/// Counts its live copies.
#[derive(Clone)]
struct OneLine {
	alive: Arc<()>,
	wakes: Arc<Wakes>,
	sent:  Arc<std::sync::atomic::AtomicBool>,
}

impl OneLine {
	fn new(wakes: &Arc<Wakes>) -> Self {
		Self { alive: Arc::new(()), wakes: Arc::clone(wakes), sent: Arc::default() }
	}
}

impl File for OneLine {
	fn poll_read(&mut self, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		use std::sync::atomic::Ordering::SeqCst;
		if !self.sent.swap(true, SeqCst) {
			buf[..3].copy_from_slice(b"go\n");
			return Poll::Ready(Ok(3));
		}
		// Each wake unparks this thread, which polls the pumps: the test's
		// own thread. Only the runner bounds a waiter that never reports.
		while self.wakes.count.load(SeqCst) < 2 {
			thread::park();
		}
		Poll::Pending
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Err(io::ErrorKind::Unsupported.into()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Pipe
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(self.clone()))
	}
}

/// `sh -c 'read x; exit 3'` with [`OneLine`] as its stdin, under a waiter
/// thread (`Exits::Thread`), and the waker the input polls count.
fn reads_one_line(s: &NativeSpawner) -> (Box<dyn ExtProc>, OneLine, Arc<Wakes>) {
	let env = EnvView::default();
	let wakes = Arc::new(Wakes { count: 0.into(), thread: thread::current() });
	let input = OneLine::new(&wakes);
	let a = sh("read x; exit 3");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::File(Box::new(input.clone())), StdioSpec::Null, StdioSpec::Null];
	(s.spawn(sp).unwrap(), input, wakes)
}

/// The waiter can record the exit after `poll_wait` read the input pumps'
/// cancel and before it polls the exit ([`OneLine`] makes it so). The
/// exit is reported only once the input pump is gone, with the engine
/// object it reads.
#[test]
fn an_exit_recorded_during_the_pump_poll_is_reported_without_the_input_pump() {
	let s = NativeSpawner::default();
	let (mut p, input, wakes) = reads_one_line(&s);
	let waker = Waker::from(Arc::clone(&wakes));
	let polled = p.poll_wait(&mut Context::from_waker(&waker));
	assert_eq!(polled, Poll::Ready(ExitStatus::Exited(3)), "one poll sees the exit");
	assert_eq!(
		Arc::strong_count(&input.alive),
		1,
		"the exit was reported while the input pump held the engine object"
	);
}

/// [`an_exit_recorded_during_the_pump_poll_is_reported_without_the_input_pump`]
/// through `poll_event`, job control's poll.
#[test]
fn an_exit_event_recorded_during_the_pump_poll_comes_without_the_input_pump() {
	use crate::bash::ProcEvent;
	let s = NativeSpawner::default();
	let (mut p, input, wakes) = reads_one_line(&s);
	let waker = Waker::from(Arc::clone(&wakes));
	let polled = p.poll_event(&mut Context::from_waker(&waker));
	assert_eq!(
		polled,
		Poll::Ready(ProcEvent::Exited(ExitStatus::Exited(3))),
		"one poll sees the exit"
	);
	assert_eq!(
		Arc::strong_count(&input.alive),
		1,
		"the exit event came while the input pump held the engine object"
	);
}

#[test]
fn external_dies_of_sigpipe_when_the_engine_reader_is_gone() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = argv(&["/usr/bin/yes"]);
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, MemFile::broken().boxed(), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	// The test harness ignores SIGPIPE; the child gets the default back, so
	// PIPESTATUS shows 141 like bash.
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Pipe));
}

#[test]
fn ignored_sigpipe_turns_into_a_write_error() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = argv(&["/usr/bin/yes"]);
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, MemFile::broken().boxed(), StdioSpec::Null];
	sp.sigmask_ign = SigSet::EMPTY.with(Signal::Pipe);
	let mut p = s.spawn(sp).unwrap();
	match wait(&mut p) {
		ExitStatus::Exited(code) => assert_ne!(code, 0, "yes reports the EPIPE"),
		other => panic!("SIGPIPE was not ignored: {other:?}"),
	}
}

#[cfg(target_os = "linux")]
#[test]
fn ignored_realtime_max_reaches_the_child() {
	let env = EnvView::default();
	let s = spawner(Sessions::Share, Duration::from_millis(100));
	let a = sh("kill -s 64 $$; exit 7");
	let mut sp = spec(&a, &env, NEW);
	sp.sigmask_ign = SigSet::EMPTY.with(Signal::Rtmax);
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(7));
}

#[test]
fn ignored_signals_reach_the_child_through_the_fork_path() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh("kill -USR1 $$; exit 7");
	assert!(!super::host_ignores(Signal::Usr1));
	let mut sp = spec(&a, &env, NEW);
	sp.sigmask_ign = SigSet::EMPTY.with(Signal::Usr1);
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(7), "USR1 ignored on entry");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Usr1), "default disposition");
}

#[test]
fn signal_the_host_ignores_after_a_spawn_is_reset_in_later_children() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let a = sh("kill -USR2 $$; exit 7");
	assert_eq!(wait(&mut s.spawn(spec(&a, &env, NEW)).unwrap()), ExitStatus::Signaled(Signal::Usr2));
	// SAFETY: nextest runs each test in its own process; nothing else here
	// uses USR2, and the default comes back below.
	unsafe { libc::signal(libc::SIGUSR2, libc::SIG_IGN) };
	crate::sys::dispositions_changed();
	let status = wait(&mut s.spawn(spec(&a, &env, NEW)).unwrap());
	// SAFETY: as above.
	unsafe { libc::signal(libc::SIGUSR2, libc::SIG_DFL) };
	crate::sys::dispositions_changed();
	assert_eq!(
		status,
		ExitStatus::Signaled(Signal::Usr2),
		"the host's new SIG_IGN leaked into the child"
	);
}

/// glibc's own signals, 32 and 33 (`super::internal`): an external gets
/// them as bash's fork and exec leaves them, on each of the three paths.
/// Each test changes them for its whole process, so it runs again in
/// processes of its own ([`glibc_signals::isolated`]).
#[cfg(all(
	target_os = "linux",
	target_env = "gnu",
	any(target_arch = "x86_64", target_arch = "aarch64")
))]
mod glibc_signals {
	use std::{io, os::unix::process::CommandExt as _, sync::atomic::Ordering};

	use super::{
		super::internal::{self, IGNORED_AT_LOAD, READ, SIGNALS},
		NEW, process_umask, sh, spec, wait,
	};
	use crate::{
		bash::{ChildRedirs, EnvView, ExitStatus, SigSet},
		sys::spawn::NativeSpawner,
	};

	/// Set in the processes [`isolated`] starts.
	const CHILD: &str = "PI_SHELL_GLIBC_SIGNALS_CHILD";

	/// Run test `name` of this module again, alone, in a process of its own
	/// that starts with both signals' handler `entry`: once as the host
	/// starts processes, and once under a seccomp filter that answers
	/// `clone3` with `ENOSYS` ([`refuse_clone3`]), so that glibc's
	/// `posix_spawn` takes the path that sets both to `SIG_IGN` on any
	/// machine. True in those processes: the caller runs its body there.
	fn isolated(name: &str, entry: libc::sighandler_t) -> bool {
		if let Some(how) = std::env::var_os(CHILD) {
			assert!(how != "refused" || internal::spawn_ignores(), "clone3 is not refused");
			return true;
		}
		let entry = internal::with_handler(entry);
		for refused in [false, true] {
			let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
			cmd.arg("--exact")
				.arg(format!("sys::spawn::unix::tests::glibc_signals::{name}"))
				.env(CHILD, if refused { "refused" } else { "host" });
			// SAFETY: this runs after fork, before exec, and makes only
			// system calls on data prepared before the fork.
			unsafe {
				cmd.pre_exec(move || {
					for sig in SIGNALS {
						internal::action(sig, Some(&entry))?;
					}
					if refused {
						refuse_clone3()?;
					}
					Ok(())
				});
			}
			let output = cmd.output().unwrap();
			let out = String::from_utf8_lossy(&output.stdout);
			let err = String::from_utf8_lossy(&output.stderr);
			assert!(output.status.success(), "clone3 refused: {refused}\n{out}{err}");
			assert!(out.contains("1 passed"), "the process ran no test: {out}");
		}
		false
	}

	/// Install a seccomp filter that answers `clone3` with `ENOSYS` and
	/// lets every other call through. Async-signal-safe.
	fn refuse_clone3() -> io::Result<()> {
		#[cfg(target_arch = "x86_64")]
		const ARCH: u32 = 0xc000_003e; // AUDIT_ARCH_X86_64
		#[cfg(target_arch = "aarch64")]
		const ARCH: u32 = 0xc000_00b7; // AUDIT_ARCH_AARCH64
		const CLONE3: u32 = 435;
		// Classic BPF (linux/filter.h): load a word of `seccomp_data`, jump
		// when equal, return; and the seccomp actions.
		const LOAD: u16 = 0x20;
		const JEQ: u16 = 0x15;
		const RET: u16 = 0x06;
		const ALLOW: u32 = 0x7fff_0000;
		const ERRNO: u32 = 0x0005_0000;
		let op = |code, jt, jf, k| libc::sock_filter { code, jt, jf, k };
		let mut filter = [
			op(LOAD, 0, 0, 4), // the architecture
			op(JEQ, 1, 0, ARCH),
			op(RET, 0, 0, ALLOW),
			op(LOAD, 0, 0, 0), // the call's number
			op(JEQ, 0, 1, CLONE3),
			op(RET, 0, 0, ERRNO | libc::ENOSYS as u32),
			op(RET, 0, 0, ALLOW),
		];
		let prog = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_mut_ptr() };
		// SAFETY: plain prctl calls; `prog` points at `filter`, which the
		// kernel copies during the call.
		let rc = unsafe {
			if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 {
				libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &raw const prog)
			} else {
				-1
			}
		};
		if rc == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}

	/// Set both signals' handler to `handler` in this process (with the
	/// system call: glibc refuses).
	fn set_actions(handler: libc::sighandler_t) {
		for sig in SIGNALS {
			internal::action(sig, Some(&internal::with_handler(handler))).unwrap();
		}
		crate::sys::dispositions_changed();
	}

	/// The ways an external starts, each forced but the first.
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	enum Path {
		/// The spec as given: `posix_spawn` where it can express it.
		Given,
		/// std's fork: a umask the process does not have.
		Fork,
		/// The bare fork: redirections left to the process.
		BareFork,
	}

	const PATHS: [Path; 3] = [Path::Given, Path::Fork, Path::BareFork];

	/// `sh -c "kill -s SIG $$; exit 7"` started by `path`: its status.
	fn kill_self(s: &NativeSpawner, path: Path, sig: i32) -> ExitStatus {
		let env = EnvView::default();
		let a = sh(&format!("kill -s {sig} $$; exit 7"));
		let mut sp = spec(&a, &env, NEW);
		match path {
			Path::Given => {},
			Path::Fork => sp.umask = if sp.umask == 0o077 { 0o022 } else { 0o077 },
			Path::BareFork => {
				sp.redirs = Some(ChildRedirs { list: Vec::new(), exec_diag: "test: sh: ".into() });
			},
		}
		wait(&mut s.spawn(sp).unwrap())
	}

	/// Whether the spec as given takes `posix_spawn`.
	fn by_posix_spawn(s: &NativeSpawner) -> bool {
		let state = &s.shared.state;
		state.add_chdir.is_some() && state.posix_eligible(process_umask().unwrap(), SigSet::EMPTY)
	}

	/// Each path and signal with `status(path, signal)`.
	fn rows(mut status: impl FnMut(Path, i32) -> ExitStatus) -> Vec<(Path, i32, ExitStatus)> {
		PATHS
			.into_iter()
			.flat_map(|path| SIGNALS.map(|sig| (path, sig)))
			.map(|(path, sig)| (path, sig, status(path, sig)))
			.collect()
	}

	/// A glibc `posix_spawn` child that does not use `clone3` (glibc before
	/// 2.38, or `clone3` refused) set both signals to `SIG_IGN` before the
	/// exec, so `sh` outlived `kill -s 33 $$`. Each path leaves them at
	/// their default when this process does not ignore them.
	#[test]
	fn a_child_gets_glibc_signals_at_their_default() {
		if !isolated("a_child_gets_glibc_signals_at_their_default", libc::SIG_DFL) {
			return;
		}
		let s = NativeSpawner::default();
		assert!(by_posix_spawn(&s), "the spec as given takes posix_spawn");
		let got = rows(|path, sig| kill_self(&s, path, sig));
		assert_eq!(got, rows(|_, sig| ExitStatus::SignaledRaw(sig)));
	}

	/// Ones this process ignores stay ignored, as bash passes on a signal
	/// ignored on entry.
	#[test]
	fn glibc_signals_the_process_ignores_stay_ignored() {
		if !isolated("glibc_signals_the_process_ignores_stay_ignored", libc::SIG_DFL) {
			return;
		}
		set_actions(libc::SIG_IGN);
		let s = NativeSpawner::default();
		assert!(by_posix_spawn(&s), "the spec as given takes posix_spawn");
		let got = rows(|path, sig| kill_self(&s, path, sig));
		assert_eq!(got, rows(|_, _| ExitStatus::Exited(7)));
	}

	/// Entered with both signals ignored, as glibc's `posix_spawn` hands
	/// them on where it does not use `clone3`. On glibc 2.34 or later the
	/// reading at load sees them ignored, and every child still gets them
	/// ignored after glibc gave `SIGSETXID` a handler of its own at this
	/// process's first thread. On glibc 2.33 and older, libpthread's preinit
	/// installs both handlers before the reading, so it sees nothing and the
	/// children get both at the default (the stated limit). Either way,
	/// where glibc's child ignores them itself, the spec as given takes
	/// `posix_spawn`.
	#[test]
	fn glibc_signals_ignored_when_the_process_started_stay_ignored() {
		if !isolated("glibc_signals_ignored_when_the_process_started_stay_ignored", libc::SIG_IGN) {
			return;
		}
		let seen = internal::glibc_at_least(2, 34);
		let at_load = if seen { READ | 0b11 } else { READ };
		assert_eq!(IGNORED_AT_LOAD.load(Ordering::Relaxed), at_load, "the reading at load");
		std::thread::spawn(|| {}).join().unwrap();
		let s = NativeSpawner::default();
		assert_eq!(by_posix_spawn(&s), internal::spawn_ignores(), "posix_spawn when it can");
		let got = rows(|path, sig| kill_self(&s, path, sig));
		let want = if seen {
			rows(|_, _| ExitStatus::Exited(7))
		} else {
			rows(|_, sig| ExitStatus::SignaledRaw(sig))
		};
		assert_eq!(got, want);
	}

	/// One with a handler stays ignored in a child when the process ignored
	/// it at load (by a fork where glibc's `posix_spawn` would reset it),
	/// and goes to its default when the process did not.
	#[test]
	fn a_glibc_signal_under_a_handler_stays_ignored_only_if_ignored_at_load() {
		/// Stands in for glibc's handler.
		extern "C" fn stand_in(_: libc::c_int) {}
		if !isolated(
			"a_glibc_signal_under_a_handler_stays_ignored_only_if_ignored_at_load",
			libc::SIG_DFL,
		) {
			return;
		}
		let stand_in: extern "C" fn(libc::c_int) = stand_in;
		set_actions(stand_in as libc::sighandler_t);
		let s = NativeSpawner::default();
		let run = |ignored_at_load: bool| {
			IGNORED_AT_LOAD.store(if ignored_at_load { READ | 0b11 } else { READ }, Ordering::Relaxed);
			crate::sys::dispositions_changed();
			// glibc's own child ignores them where it does not use clone3.
			let posix = !ignored_at_load || internal::spawn_ignores();
			assert_eq!(by_posix_spawn(&s), posix, "posix_spawn when it can");
			rows(|path, sig| kill_self(&s, path, sig))
		};
		assert_eq!(run(true), rows(|_, _| ExitStatus::Exited(7)), "ignored at load");
		assert_eq!(run(false), rows(|_, sig| ExitStatus::SignaledRaw(sig)), "not ignored at load");
	}

	/// The bits set are the ones glibc's own `sigismember` reads as 32 and
	/// 33, and no other.
	#[test]
	fn glibc_signal_bits_are_the_ones_glibc_reads() {
		if !isolated("glibc_signal_bits_are_the_ones_glibc_reads", libc::SIG_DFL) {
			return;
		}
		set_actions(libc::SIG_DFL);
		// SAFETY: sigset_t is plain data, initialized by sigemptyset.
		let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: `set` is a valid, writable sigset_t.
		unsafe { libc::sigemptyset(&raw mut set) };
		internal::add_defaults(&mut set);
		let members: Vec<i32> = (1..65)
			// SAFETY: `set` is initialized.
			.filter(|&n| unsafe { libc::sigismember(&raw const set, n) } == 1)
			.collect();
		assert_eq!(members, SIGNALS);
	}
}

#[test]
fn umask_probe_preserves_concurrent_file_creation_mask() {
	use std::{
		os::unix::fs::{OpenOptionsExt, PermissionsExt},
		sync::atomic::{AtomicBool, Ordering},
	};

	const MARKER: &str = "PI_SHELL_UMASK_PROBE_CHILD";
	if std::env::var_os(MARKER).is_none() {
		let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
		cmd.args([
			"--exact",
			"sys::spawn::unix::tests::umask_probe_preserves_concurrent_file_creation_mask",
		])
		.env(MARKER, "1");
		// SAFETY: this runs after fork, before exec, and changes only the
		// isolated test subprocess's mask.
		unsafe {
			cmd.pre_exec(|| {
				libc::umask(0o077);
				Ok(())
			});
		}
		let output = cmd.output().unwrap();
		assert!(
			output.status.success(),
			"isolated probe test failed: {}{}",
			String::from_utf8_lossy(&output.stdout),
			String::from_utf8_lossy(&output.stderr)
		);
		assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"), "child ran no test");
		return;
	}

	assert_eq!(process_umask(), Some(0o077));
	let dir = tempfile::tempdir().unwrap();
	let done = Arc::new(AtomicBool::new(false));
	let probing = Arc::clone(&done);
	let start = Arc::new(std::sync::Barrier::new(2));
	let probe_start = Arc::clone(&start);
	let probe = thread::spawn(move || {
		probe_start.wait();
		while !probing.load(Ordering::Relaxed) {
			assert_eq!(process_umask(), Some(0o077));
		}
	});
	start.wait();
	let mut wrong_modes = Vec::new();
	for n in 0..2000 {
		let path = dir.path().join(n.to_string());
		let file = std::fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.mode(0o666)
			.open(path)
			.unwrap();
		let mode = file.metadata().unwrap().permissions().mode() & 0o777;
		if mode != 0o600 {
			wrong_modes.push(mode);
		}
	}
	done.store(true, Ordering::Relaxed);
	probe.join().unwrap();
	assert_eq!(process_umask(), Some(0o077), "the process mask changed");
	let after = std::fs::OpenOptions::new()
		.write(true)
		.create_new(true)
		.mode(0o666)
		.open(dir.path().join("after"))
		.unwrap();
	assert_eq!(after.metadata().unwrap().permissions().mode() & 0o777, 0o600);
	assert!(wrong_modes.is_empty(), "concurrent files had wrong modes: {wrong_modes:?}");

	// This subprocess runs only this test. Change its own mask after the
	// reader thread joined, then restore it before checking the result.
	// SAFETY: umask cannot fail; neither call affects the parent process.
	let previous = unsafe { libc::umask(0o027) };
	let changed = process_umask();
	// SAFETY: restore the mask returned above in this isolated subprocess.
	unsafe { libc::umask(previous) };
	assert_eq!(changed, Some(0o027), "the probe returned a cached mask");
}

#[test]
fn umask_reaches_the_child_on_both_paths() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let state = State::new(None);
	let host = process_umask().unwrap();
	let a = sh("umask");
	for mask in [host, 0o027] {
		assert_eq!(state.posix_eligible(mask, SigSet::EMPTY), mask == host);
		let out = MemFile::default();
		let mut sp = spec(&a, &env, NEW);
		sp.umask = mask;
		sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
		let mut p = s.spawn(sp).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Exited(0));
		assert_eq!(out.captured().trim(), format!("{mask:04o}").as_bytes());
	}
}

#[test]
fn rlimits_reach_the_child_and_unknown_resources_are_skipped() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let (_, hard) = crate::sys::rlimit::get(Rlimit::Nofile).unwrap();
	// FreeBSD-only `Swap` exists nowhere here: skipped, not an error.
	let limits = [(Rlimit::Swap, Some(1), Some(1)), (Rlimit::Nofile, Some(64), hard)];
	let a = sh("ulimit -n");
	let out = MemFile::default();
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	sp.rlimits = &limits;
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured().trim(), b"64");
	assert_eq!(
		crate::sys::rlimit::get(Rlimit::Nofile).unwrap().1,
		hard,
		"the host's limits are untouched"
	);
}

#[test]
fn an_impossible_rlimit_fails_the_spawn_with_the_os_error() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let (soft, _) = crate::sys::rlimit::get(Rlimit::Nofile).unwrap();
	let soft = soft.unwrap();
	// Soft above hard: EINVAL from setrlimit in the child.
	let limits = [(Rlimit::Nofile, Some(soft), Some(soft - 1))];
	let a = argv(&["/usr/bin/true"]);
	let mut sp = spec(&a, &env, NEW);
	sp.rlimits = &limits;
	let err = s.spawn(sp).err().expect("setrlimit refuses soft > hard");
	assert_eq!(err.raw_os_error(), Some(libc::EINVAL), "{err}");
}

/// A reused descriptor map must not reuse another command's working directory.
#[test]
fn consecutive_spawns_apply_their_current_cwd() {
	let s = NativeSpawner::default();
	let env = EnvView::default();
	for cwd in ["/", "/usr", "/"] {
		let a = sh(&format!("test . -ef {cwd}"));
		let mut sp = spec(&a, &env, NEW);
		sp.cwd = cwd.as_bytes().as_bstr();
		let mut p = s.spawn(sp).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Exited(0), "{cwd}");
	}
}

/// Cached C environments must track changes, deletion, and recovery after
/// rejecting an invalid command environment.
#[test]
fn consecutive_spawns_receive_their_current_environment() {
	let s = NativeSpawner::default();
	for (value, script) in [
		(Some("first"), r#"test "$SPAWN_CACHE" = first"#),
		(Some("second"), r#"test "$SPAWN_CACHE" = second"#),
		(None, r#"test "${SPAWN_CACHE+x}" != x"#),
	] {
		let pairs = value
			.into_iter()
			.map(|v| ("SPAWN_CACHE".into(), v.into()))
			.collect();
		let env = EnvView::new(pairs);
		let a = sh(script);
		for _ in 0..2 {
			let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
			assert_eq!(wait(&mut p), ExitStatus::Exited(0));
		}
	}
	let a = sh(r#"test "$SPAWN_CACHE" = recovered"#);
	let invalid = EnvView::new(vec![("SPAWN_CACHE".into(), BString::from(b"bad\0value"))]);
	assert_eq!(s.spawn(spec(&a, &invalid, NEW)).err().unwrap().kind(), io::ErrorKind::InvalidInput);
	let env = EnvView::new(vec![("SPAWN_CACHE".into(), "recovered".into())]);
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
}

#[test]
fn cwd_env_and_argv0_reach_the_child() {
	let s = NativeSpawner::default();
	let env = EnvView::new(vec![(BString::from("FOO"), BString::from("b a r"))]);
	let a = argv(&["/bin/sh", "-c", "cd -P . && pwd; printf '%s|%s\\n' \"$FOO\" \"$0\"", "name0"]);
	let out = MemFile::default();
	let mut sp = spec(&a, &env, NEW);
	sp.cwd = b"/usr".as_bstr();
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured(), b"/usr\nb a r|name0\n");
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn missing_spawn_chdir_uses_fork_with_the_requested_cwd() {
	let mut s = NativeSpawner::default();
	Arc::get_mut(&mut s.shared).unwrap().state.add_chdir = None;
	let env = EnvView::default();
	let a = argv(&["/bin/pwd"]);
	let out = MemFile::default();
	let mut sp = spec(&a, &env, NEW);
	sp.cwd = b"/usr".as_bstr();
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured(), b"/usr\n");
}

#[test]
fn extra_fds_are_passed_to_the_child() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let pumped = MemFile::default();
	let path = std::env::temp_dir().join(format!("obash-extra-{}", std::process::id()));
	let direct = std::fs::File::create(&path).unwrap();
	let a = sh("echo pumped >&5; echo direct >&7; read x <&5; echo \"got $x\" >&7");
	let mut sp = spec(&a, &env, NEW);
	let duplex = MemFile { input: MemFile::feed(b"back\n").input, ..pumped.clone() };
	sp.extra_fds = vec![
		(5, StdioSpec::File(Box::new(duplex))),
		(7, StdioSpec::File(Box::new(crate::sys::StdFile::new(direct)))),
	];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(pumped.captured(), b"pumped\n", "fd 5 pumped both ways over a socket pair");
	assert_eq!(std::fs::read(&path).unwrap(), b"direct\ngot back\n", "fd 7 passed through");
	std::fs::remove_file(&path).unwrap();
}

/// bash hands one kernel pipe to every process that inherits a procsub fd.
/// `cat < <(…)` holds it as fd 0 and fd 63; in `diff <(a) <(b)`, `b` holds
/// `a`'s fd 63 without reading it. A pump per handoff would race for the
/// bytes and lose what it took into a pipe nobody reads (varenv8, shopt1).
#[test]
fn one_engine_reader_feeds_every_external_it_is_handed_to() {
	let env = EnvView::default();
	let spawner = NativeSpawner::default();
	let data = b"line1\nline2\n";

	// Same object on fd 0 and fd 63 of one external.
	let sub = crate::bash::FdRef::from_file(Box::new(MemFile::reader(data)));
	let out = MemFile::default();
	let cat = argv(&["/bin/cat"]);
	let mut both = spec(&cat, &env, NEW);
	both.stdio = [StdioSpec::Pipe(sub.clone()), out.boxed(), StdioSpec::Null];
	both.extra_fds = vec![(63, StdioSpec::Pipe(sub))];
	let mut child = spawner.spawn(both).unwrap();
	assert_eq!(wait(&mut child), ExitStatus::Exited(0));
	assert_eq!(out.captured(), data, "fd 63 took nothing from stdin");

	// A bystander inherits the object first and never reads it; the reader
	// spawned after it still gets everything.
	let sub = crate::bash::FdRef::from_file(Box::new(MemFile::reader(data)));
	let sleep = argv(&["/bin/sleep", "30"]);
	let mut idle = spec(&sleep, &env, NEW);
	idle.extra_fds = vec![(63, StdioSpec::Pipe(sub.clone()))];
	let mut bystander = spawner.spawn(idle).unwrap();
	thread::sleep(Duration::from_millis(50));
	let out = MemFile::default();
	let by_path = sh("cat /dev/fd/63");
	let mut reader = spec(&by_path, &env, NEW);
	reader.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	reader.extra_fds = vec![(63, StdioSpec::Pipe(sub))];
	let mut child = spawner.spawn(reader).unwrap();
	assert_eq!(wait(&mut child), ExitStatus::Exited(0));
	assert_eq!(out.captured(), data, "the bystander's copy stole nothing");
	bystander.signal(Signal::Kill).unwrap();
	assert_eq!(wait(&mut bystander), ExitStatus::Signaled(Signal::Kill));
}

/// `cat <(echo hi)` / `tee >(cat)`: the external opens the substitution by
/// path. Linux reopens `/dev/fd/N` through `/proc`, which works for a pipe
/// but fails with ENXIO for a socket, so one-way extra fds must be pipes.
#[test]
fn one_way_extra_fds_can_be_opened_by_path() {
	let env = EnvView::default();
	let s = NativeSpawner::default();
	let (sub_out, out) = (MemFile::writer(), MemFile::default());
	let a = sh("cat /dev/fd/63; echo to-sub > /dev/fd/62");
	let mut sp = spec(&a, &env, NEW);
	sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
	sp.extra_fds = vec![
		(63, StdioSpec::File(Box::new(MemFile::reader(b"hi\n")))),
		(62, StdioSpec::File(Box::new(sub_out.clone()))),
	];
	let mut p = s.spawn(sp).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	assert_eq!(out.captured(), b"hi\n", "read end reopened by path");
	assert_eq!(sub_out.captured(), b"to-sub\n", "write end reopened by path");
}

#[test]
fn leftovers_lists_and_kills_processes_that_outlive_their_command() {
	let env = EnvView::default();
	for sessions in [Sessions::Detach, Sessions::Share] {
		let s = spawner(sessions, Duration::from_secs(2));
		// The background sleep outlives sh in sh's group and session.
		let a = sh("/bin/sleep 30 & exit 0");
		let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Exited(0));
		drop(p);
		// The background child shows the shell's name until it has exec'd.
		let mut left = Vec::new();
		until("background sleep exec'd", || {
			left = s.leftovers().unwrap();
			left.len() == 1 && left[0].name == "sleep"
		});
		let killed = s.kill_leftovers().unwrap();
		assert_eq!(killed, left);
		until("leftover gone", || s.leftovers().unwrap().is_empty());
	}
}

/// A spawner whose externals a [`Parker`](crate::sys::Parker) waits for.
#[cfg(target_os = "linux")]
fn parked_spawner(grace: Duration) -> NativeSpawner {
	NativeSpawner::new(SpawnConfig {
		grace,
		sessions: Sessions::Inherit,
		exits: crate::sys::Exits::Park,
		umask: None,
	})
}

/// Drive `p` as `obash` does: poll with the parker's waker, park in
/// between. The park's timeout is only how long it sleeps before polling
/// again; the exit is what ends the wait.
#[cfg(target_os = "linux")]
fn wait_parked(parker: &mut crate::sys::Parker, p: &mut Box<dyn ExtProc>) -> ExitStatus {
	let waker = parker.waker().clone();
	let mut cx = Context::from_waker(&waker);
	loop {
		if let Poll::Ready(s) = p.poll_wait(&mut cx) {
			return s;
		}
		parker.park(POLL);
	}
}

/// The exit itself ends the park (a pidfd in the poll set): the park's own
/// [`POLL`] timeout is past the runner's bound, so a park the exit did not
/// wake fails the test. No waiter thread is involved; the status is exact
/// and the process is reaped once its `ExtProc` is dropped.
#[cfg(target_os = "linux")]
#[test]
fn a_parked_external_wakes_the_parker_at_its_exit() {
	let env = EnvView::default();
	let s = parked_spawner(Duration::from_secs(2));
	let mut parker = crate::sys::Parker::new();
	for (script, status) in [
		("sleep 0.2; exit 5", ExitStatus::Exited(5)),
		("kill -KILL $$", ExitStatus::Signaled(Signal::Kill)),
	] {
		let a = sh(script);
		let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
		let pid = p.pid() as i32;
		assert_eq!(wait_parked(&mut parker, &mut p), status, "{script}");
		assert!(proc::exists(pid), "unreaped while the ExtProc lives");
		drop(p);
		assert!(!proc::exists(pid), "reaped on drop");
	}
}

/// Parked externals deliver their output before they complete, and many at
/// once each get their own exit.
#[cfg(target_os = "linux")]
#[test]
fn parked_externals_deliver_output_and_their_own_exits() {
	let env = EnvView::default();
	let s = parked_spawner(Duration::from_secs(2));
	let mut parker = crate::sys::Parker::new();
	let outs: Vec<MemFile> = (0..6).map(|_| MemFile::default()).collect();
	let scripts: Vec<Vec<BString>> = (0..6)
		.map(|i| sh(&format!("sleep 0.{i}; printf out{i}; exit {i}")))
		.collect();
	let mut running: Vec<_> = scripts
		.iter()
		.zip(&outs)
		.map(|(a, out)| {
			let mut sp = spec(a, &env, NEW);
			sp.stdio = [StdioSpec::Null, out.boxed(), StdioSpec::Null];
			s.spawn(sp).unwrap()
		})
		.collect();
	for (i, p) in running.iter_mut().enumerate().rev() {
		assert_eq!(wait_parked(&mut parker, p), ExitStatus::Exited(i32::try_from(i).unwrap()));
		assert_eq!(outs[i].captured(), format!("out{i}").as_bytes());
	}
	drop(running);
	assert!(s.leftovers().unwrap().is_empty());
}

/// Abandoned while running, a parked external is escalated and then reaped
/// by a waiter; without any parker its exit is still observed.
#[cfg(target_os = "linux")]
#[test]
fn parked_externals_are_reaped_after_abandon_and_work_without_a_parker() {
	let env = EnvView::default();
	let s = parked_spawner(Duration::from_millis(300));
	let parker = crate::sys::Parker::new();
	let a = sh(&format!("trap '' TERM; exec {} 30", crate::testkit::child::on_path("sleep")));
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	let pid = p.pid() as i32;
	let waker = parker.waker().clone();
	assert!(p.poll_wait(&mut Context::from_waker(&waker)).is_pending());
	until("exec'd", || proc::info(pid).is_some_and(|i| i.name == "sleep"));
	drop(p);
	until("killed and reaped", || !proc::exists(pid));
	drop(parker);

	let a = sh("exit 7");
	let mut p = s.spawn(spec(&a, &env, NEW)).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Exited(7));
}
