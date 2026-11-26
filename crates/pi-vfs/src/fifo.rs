//! One end of a FIFO opened on a helper thread ([`FifoOpen`]), and the pin
//! that identifies the FIFO the open started on ([`FifoPin`]).

#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::{
	ffi::{CStr, CString, OsStr},
	fs, io,
	os::{
		fd::{AsFd, BorrowedFd, FromRawFd, OwnedFd, RawFd},
		unix::{
			ffi::OsStrExt,
			fs::{MetadataExt, OpenOptionsExt},
		},
	},
	panic::{AssertUnwindSafe, catch_unwind},
	path::{Path, PathBuf},
	sync::{Arc, Weak},
	task::{Context, Poll, Waker},
	thread,
	time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex, MutexGuard};

use crate::file::POLL_SLICE;

/// One end of a FIFO being opened on a helper thread.
///
/// A read-only or write-only open of a FIFO waits in `open(2)` until the
/// other end opens. The helper runs the caller's open, so it returns exactly
/// when a blocking open would, while the caller waits for it as a pending
/// operation ([`FifoOpen::poll`], [`FifoOpen::wait_for`]) and gives it up by
/// dropping it.
///
/// Dropping an open whose result was not taken leaves no end of the FIFO
/// behind once the drop returns, but for a helper it leaves (below). A
/// helper that has not passed its check of the cancel opens nothing, and a
/// result it stored that was not taken is closed. A helper that passed its
/// check is in `open(2)`, or about to enter it: the drop holds the FIFO open
/// for reading and writing, which never waits on a FIFO and completes that
/// open whether it waits already or not yet, until the helper has ended,
/// closing what it got. The FIFO's real other end can observe that brief
/// peer, as it can every release: a writer that comes and goes reads as end
/// of file, a reader that comes and goes makes a writer's first write fail
/// with `EPIPE`. Other opens of the same end waiting at that moment are
/// released with it.
///
/// The FIFO is the one the open started on ([`FifoPin`]). Where
/// `/proc/self/fd` is there (Linux with `/proc`), the drop opens it through
/// the pin's `/proc/self/fd/N`, so it reaches that FIFO whatever its name
/// holds later, and so does the helper, unless the open has `O_CREAT`
/// (`creates`): that helper opens the name with the caller's own options but
/// for a write's `O_TRUNC` (below), so the kernel's check of the name applies
/// (`fs.protected_fifos` in a sticky directory, which `may_create_in_sticky`
/// reads only under `O_CREAT`; the checks of `O_TRUNC` and `O_EXCL` hold
/// through the magic link). Elsewhere (off Linux, and on Linux without
/// `/proc`) the helper and the drop open the name, and the drop opens it only
/// while the name names the pinned FIFO, before and after its open (a peer of
/// another FIFO is closed at once).
///
/// A helper that opens the name is waited for only while the name names the
/// pinned FIFO, and for at most a second (`LEAVE_AFTER`): the drop checks the
/// name every poll slice ([`crate::POLL_SLICE`]) at most, and leaves the
/// helper once the name names another file or the bound has passed. The
/// helper's open of the pinned FIFO ends at once, as the drop holds its two
/// ends; one still in `open(2)` at the bound waits on another FIFO, which
/// the name named at the moment of its open and may no longer name: given
/// to another FIFO B (`rm p; mkfifo p`, or `mv p p.a; mkfifo p`) before the
/// helper's open, and maybe given back (`mv p p.b; mv p.a p`) after it. A
/// drop that waited longer would hold the pinned FIFO's two ends for as long,
/// and keep the thread that dropped the open. A helper the drop leaves before
/// its last check, just before `open(2)`, opens nothing. Where
/// `/proc/self/fd` reaches the pin, one whose open of the name reached the
/// pinned FIFO before the name changed is completed by the drop's peer and
/// closes what it got at once, but the drop, which leaves it, may return a
/// moment before that close. Without it the drop's peer goes by the name
/// too, and completes such a helper only if it opened before the name
/// changed; else that helper waits on the pinned FIFO ("What is left",
/// below). One past its last check that waits on B is reached by no
/// release: the drop's peer is of the pinned FIFO. The helper thread then
/// stays in `open(2)`, holding the pin (and, for a directory entry, two
/// duplicates of the directory's descriptor: the name's and its open's),
/// until B's next peer connects; if B's name goes first (a script that ends
/// with `rm p`), nothing can open B again, and they stay for the life of the
/// process. A reader peer of B then reads end of file; a writer peer's writes
/// before the helper's end closes land in B's buffer and are lost, and its
/// later writes fail with `EPIPE`. That is a trade-off: a release of B by
/// name would reach that helper, but it would also complete every other open
/// waiting on B's same end, a FIFO the open never pinned; keeping a release
/// from reaching a FIFO its open did not start on is what the pin is for.
///
/// The helper's open of the name never truncates for a write: the caller
/// leaves `O_TRUNC` out of it, and the helper applies it itself, under the
/// open's lock and only while the open has not been dropped, to a regular
/// file the name names by then (see [`TruncateRegular`]; a FIFO ignores
/// `O_TRUNC`). That costs two things, both only where a regular file took the
/// FIFO's name between the open's `stat` and its helper's open: a `poll` or
/// `wait_for` of the open, on whatever thread, and its drop wait for the
/// truncation, which a large file makes long; and bytes another writer puts
/// in the file between the helper's open and its truncation are lost, where
/// an `O_TRUNC` open truncates before any write can come. A helper whose open
/// was dropped closes what it opened at once, unchanged. A write asks the
/// write permission `O_TRUNC` asks anyway; a read-only open that asks for
/// `O_TRUNC` keeps it, so the kernel still asks that permission, and so does
/// the reopen of the pin, which opens the FIFO.
///
/// What is left: a FIFO this process may not open for both reading and
/// writing keeps its helper until its other end opens; the helper then takes
/// that connection and closes it. So does a helper the drop can reach only by
/// name (no `/proc/self/fd`) when the pinned FIFO had another name by the
/// drop: the helper waits on that FIFO under its new name, and takes its next
/// connection. An open started with no pin ([`FifoOpen::start_pinned`] given
/// `None`: the FIFO was gone, or no FIFO, by the pin) is never released;
/// [`FifoOpen::start`] pins what its `meta` describes when it cannot take a
/// pin. A helper held up for longer than the bound between its last check and
/// its `open(2)` (a loaded node can hold a thread that long) opens the name
/// after the drop has gone. It writes nothing, and closes what it opened at
/// once; until then it holds its thread and the pin. Where the name still
/// names the FIFO, it waits there until the other end opens, which then sees
/// end of file (a writer's first write fails with `EPIPE`). A write's helper
/// truncates nothing; a read-only open that asks for `O_TRUNC` keeps it
/// (above), so its helper truncates a regular file the name names by then, as
/// that open asks.
///
/// Where the name names nothing by then, an open that creates leaves an empty
/// regular file there, as the open would have, and nothing else. That cannot
/// be avoided: the open needs `O_CREAT` so that the kernel checks
/// `fs.protected_fifos` when the name names a FIFO, and `O_CREAT` creates a
/// missing file in the same `open(2)`. Removing that file afterwards would
/// remove by its name a file the helper cannot prove is the one it created.
///
/// A read-only open started with [`FifoOpen::start_reading`] (or
/// [`FifoOpen::start_pinned_reading`]) under gVisor ([`on_gvisor`]) does
/// not depend on its `open(2)` being woken. gVisor before
/// google/gvisor@d6786915 can leave a reader in `open(2)` after a writer
/// opened, wrote and closed. While the helper is still in `open(2)` after
/// [`FIRST_PROBE`] (then twice as long each time, up to [`LAST_PROBE`]), the
/// open looks at the pinned FIFO, the way the drop reaches it, through a read
/// end that does not wait. The first look opens that end, and it stays open
/// until the open is over, so a writer it lets out of `open(2)` always has a
/// reader to write to. Bytes in the FIFO make that end, made blocking, the
/// open's result, and write opens that do not wait (the sleeping helper is a
/// reader, so they succeed) wake the helper, whose end is closed. One thread
/// for the process makes the looks of every such open ([`Watch`]); an open
/// starts no thread for them, and the caller's thread does nothing for them.
/// A helper the look took the open from that even the drop's end does not
/// wake within [`RESCUED_JOIN`] is left: it holds no end of the FIFO until
/// its `open(2)` returns, and then closes that end. Such helpers are counted
/// ([`LEFT`]); past [`MAX_LEFT`] a read-only open is not looked at, so no
/// more are left.
///
/// Elsewhere nothing looks: on Linux a blocking reader waits for a writer
/// even when bytes wait in the FIFO, and a look would take them. Under gVisor
/// the look takes whatever bytes it finds, so these are its limits:
/// - a FIFO that holds bytes another reader left, with no writer, gives them to
///   the open at the first look, where Linux waits for a writer;
/// - gVisor keeps a FIFO's bytes after every end of it closed, where Linux
///   frees them (bytes written through an end opened for reading and writing,
///   or left unread by a reader that closed): the first look takes those too,
///   where Linux waits for a writer;
/// - a writer that closes without writing leaves no bytes to see: the helper
///   can wait as before;
/// - once the look took the open, its write opens (up to [`WAKES`],
///   [`WAKE_GAP`] apart, until the helper's `open(2)` returns) are each a
///   writer that comes and goes for another reader waiting in `open(2)` on the
///   same FIFO at that moment, which then reads end of file.
pub struct FifoOpen<T> {
	shared: Arc<Shared<T>>,
	node:   Arc<Node>,
	helper: Option<thread::JoinHandle<()>>,
}

/// How long a read-only open waits in `open(2)` before it first looks for a
/// writer the helper missed ([`FifoOpen::start_reading`]).
pub const FIRST_PROBE: Duration = Duration::from_millis(50);

/// The longest wait between two looks.
pub const LAST_PROBE: Duration = Duration::from_secs(1);

/// How a read end found by the look becomes the open's result.
type Adopt<T> = Box<dyn FnOnce(fs::File) -> io::Result<T> + Send>;

/// How many write opens the look makes to wake a helper it took the open
/// from, at most ([`FifoOpen`]).
pub const WAKES: u32 = 100;

/// The wait between two of those write opens.
pub const WAKE_GAP: Duration = Duration::from_millis(10);

/// The look of one read-only open ([`FifoOpen::start_reading`]).
struct Look<T> {
	/// The FIFO it looks at.
	node:  Arc<Node>,
	/// Makes the look's read end the open's result: taken when it does, and
	/// the look then wakes the helper.
	adopt: Option<Adopt<T>>,
	/// The look's read end that does not wait: opened by the first look and
	/// kept until the open is over, so a writer it let out of `open(2)` has a
	/// reader. Closed under the slot's lock, so no drop finds it afterwards.
	held:  Option<fs::File>,
	/// The wait before the next look.
	wait:  Duration,
	/// Write opens left to wake the helper, once the look took the open.
	wakes: u32,
}

impl<T> Look<T> {
	const fn new(node: Arc<Node>, adopt: Adopt<T>) -> Self {
		Self { node, adopt: Some(adopt), held: None, wait: FIRST_PROBE, wakes: 0 }
	}
}

/// One open the watch looks at ([`Watch`]).
trait Looked: Send + Sync {
	/// One step of its look (or of its wake-up of the helper): `Some(wait)`
	/// when the next step is due after `wait`, `None` when the look is over.
	fn step(&self) -> Option<Duration>;
}

/// The one thread that makes the looks of every read-only open under
/// gVisor, each step when it is due. With a thread started for each open,
/// even one that never looked, obash's `{ echo a; } > f & mapfile -t l < f`
/// under gVisor hung or ended on `SIGPIPE` where it did not with no such
/// thread.
struct Watch {
	/// The opens and when each one's next step is due. Weak: an open whose
	/// `FifoOpen` and helper are gone is not looked at again.
	due:  Mutex<Vec<(Instant, Weak<dyn Looked>)>>,
	/// Notified when an open is added.
	more: Condvar,
}

static WATCH: Watch = Watch { due: Mutex::new(Vec::new()), more: Condvar::new() };

/// Whether the watch's thread runs: started by the first open looked at.
static WATCHING: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| {
	thread::Builder::new()
		.name("fifo-watch".to_owned())
		.stack_size(64 << 10)
		.spawn(|| WATCH.run())
		.is_ok()
});

impl Watch {
	/// Makes `open`'s first step due after `wait`; false when the watch's
	/// thread could not be started, so nothing looks at it.
	fn add(&self, open: Weak<dyn Looked>, wait: Duration) -> bool {
		if !*WATCHING {
			return false;
		}
		self.due.lock().push((Instant::now() + wait, open));
		self.more.notify_one();
		true
	}

	/// The watch's thread: the steps due, in turn, without the list's lock.
	fn run(&self) {
		let mut due = self.due.lock();
		loop {
			let now = Instant::now();
			let mut ready = Vec::new();
			due.retain(|(at, open)| {
				let now_due = *at <= now;
				if now_due {
					ready.push(open.clone());
				}
				!now_due
			});
			if ready.is_empty() {
				match due.iter().map(|(at, _)| *at).min() {
					Some(at) => {
						self.more.wait_until(&mut due, at);
					},
					None => self.more.wait(&mut due),
				}
				continue;
			}
			let again: Vec<_> = MutexGuard::unlocked(&mut due, || {
				ready
					.into_iter()
					.filter_map(|open| {
						let open = open.upgrade()?;
						let wait = open.step()?;
						Some((Instant::now() + wait, Arc::downgrade(&open)))
					})
					.collect()
			});
			due.extend(again);
		}
	}
}

/// Helpers a drop left after the look took their open, that have not ended
/// ([`FifoOpen`]): on gVisor each is a thread asleep in `open(2)` until a
/// writer of its FIFO comes, if one ever does, or one on its way to its last
/// check, where it ends.
static LEFT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// The most helpers left at once: past it a read-only open is not looked at
/// ([`FifoOpen::start_reading`] then opens as [`FifoOpen::start`]), so no
/// more are left. Each holds a 64 KiB stack and its open's pin (an `O_PATH`
/// descriptor on Linux), no end of the FIFO, until its `open(2)` returns.
pub const MAX_LEFT: usize = 64;

/// Whether a read-only open may be looked at with `left` helpers left.
const fn may_look(left: usize) -> bool {
	left < MAX_LEFT
}

/// Whether this process runs under gVisor, read once: the release uname(2)
/// gives ends in `-gvisor` ([`gvisor_release`]). gVisor gives
/// `4.19.0-gvisor` (`5.15.0-gvisor` with RDMA) since google/gvisor@ee08a593,
/// and `/proc/version` repeats that release with no other mark of gVisor, so
/// it adds nothing; uname needs no `/proc`. Older gVisor gives `4.4.0` and is
/// not found: its read opens are not looked at, as before.
fn on_gvisor() -> bool {
	static ON_GVISOR: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| {
		let mut name = std::mem::MaybeUninit::<libc::utsname>::uninit();
		// SAFETY: uname fills the struct it is handed, which outlives the call.
		if unsafe { libc::uname(name.as_mut_ptr()) } != 0 {
			return false;
		}
		// SAFETY: uname succeeded, so it filled the struct.
		let name = unsafe { name.assume_init() };
		// SAFETY: uname's `release` is a NUL-terminated string in the struct.
		let release = unsafe { CStr::from_ptr(name.release.as_ptr()) };
		gvisor_release(release.to_bytes())
	});
	*ON_GVISOR
}

/// Whether a kernel release uname(2) gives is gVisor's: it ends in
/// `-gvisor`, as a distribution's kernel ends in `-generic` or `-azure`.
fn gvisor_release(release: &[u8]) -> bool {
	release.ends_with(b"-gvisor")
}

/// What an open and its helper share.
struct Shared<T> {
	slot: Mutex<Slot<T>>,
	/// Notified once the helper has stored its result, and once it has
	/// ended.
	done: Condvar,
}

struct Slot<T> {
	result:    Option<io::Result<T>>,
	waker:     Option<Waker>,
	/// The result was taken.
	finished:  bool,
	/// The open was dropped: the helper opens nothing, or closes what it
	/// gets.
	cancelled: bool,
	/// The helper passed its check of `cancelled`: it is in `open(2)`, or
	/// about to enter it.
	opening:   bool,
	/// The drop left the helper: a helper that has not passed its last
	/// check opens nothing.
	abandoned: bool,
	/// Test hook: the helper passed its last check, of `abandoned`, just
	/// before its `open(2)`.
	#[cfg(test)]
	in_open:   bool,
	/// The helper has ended.
	exited:    bool,
	/// The helper's `open(2)` returned.
	returned:  bool,
	/// The drop left this helper after the look took its open
	/// ([`FifoOpen::release`]): it counts in [`LEFT`] until it returns from
	/// its `open(2)`, or ends without one (left before its last check).
	counted:   bool,
	/// The open's result is the read end the look found, not the helper's.
	rescued:   bool,
	/// The look, for a read-only open under gVisor.
	look:      Option<Look<T>>,
	/// A step of the look opens, reads or closes an end of the FIFO outside
	/// the lock: the drop waits until it has ended.
	looking:   bool,
	/// Test hook: the looks made.
	#[cfg(test)]
	looks:     usize,
	/// Test hook: after its check, the helper waits until the drop is about
	/// to join it.
	#[cfg(test)]
	hold:      bool,
	/// Test hook: with `hold`, the helper stays held until the test clears
	/// this, also while the drop joins it and after the drop left it (a
	/// helper thread descheduled after its check for longer than
	/// [`RESCUED_JOIN`]).
	#[cfg(test)]
	hold_long: bool,
	/// Test hook: the drop holds its end of the FIFO and is about to join the
	/// helper.
	#[cfg(test)]
	joining:   bool,
	/// Test hook: once released by `joining`, the helper asks this whether
	/// the FIFO's other end is open before it opens its own.
	#[cfg(test)]
	probe:     Option<fn(&Path) -> bool>,
	/// Test hook: what `probe` answered. When it answered no, the helper's
	/// open would wait for ever, so the helper skips it.
	#[cfg(test)]
	peer_held: Option<bool>,
	/// Test hook: the drop returned without joining the helper (nothing to
	/// release, or a helper that opens a name that names another file), so a
	/// helper a test holds stops holding.
	#[cfg(test)]
	left:      bool,
	/// Test hook: a reader gVisor leaves asleep. The helper opens a read end
	/// that does not wait (a reader of the FIFO, as one in `open(2)` is) and
	/// does not return until the open has a result or is cancelled.
	#[cfg(test)]
	stuck:     bool,
	/// Test hook: a `stuck` helper stays asleep, cancelled or not, until this
	/// is cleared (one gVisor does not wake even for the drop's end).
	#[cfg(test)]
	stay:      bool,
	/// Test hook: the look's first wait, in place of [`FIRST_PROBE`].
	#[cfg(test)]
	first:     Option<Duration>,
	/// Test hook: a look waits, its end open, between its open and its
	/// count, until this is cleared.
	#[cfg(test)]
	pause:     bool,
	/// Test hook: a look waits there now.
	#[cfg(test)]
	paused:    bool,
}

impl<T> Default for Slot<T> {
	fn default() -> Self {
		Self {
			result:                 None,
			waker:                  None,
			finished:               false,
			cancelled:              false,
			opening:                false,
			abandoned:              false,
			#[cfg(test)]
			in_open:                false,
			exited:                 false,
			returned:               false,
			counted:                false,
			rescued:                false,
			look:                   None,
			looking:                false,
			#[cfg(test)]
			looks:                  0,
			#[cfg(test)]
			hold:                   false,
			#[cfg(test)]
			hold_long:              false,
			#[cfg(test)]
			joining:                false,
			#[cfg(test)]
			probe:                  None,
			#[cfg(test)]
			peer_held:              None,
			#[cfg(test)]
			left:                   false,
			#[cfg(test)]
			stuck:                  false,
			#[cfg(test)]
			stay:                   false,
			#[cfg(test)]
			first:                  None,
			#[cfg(test)]
			pause:                  false,
			#[cfg(test)]
			paused:                 false,
		}
	}
}

impl<T> Slot<T> {
	/// The open is over for the look: it has a result (taken or not), was
	/// dropped, or its helper's `open(2)` returned or the helper ended.
	const fn over(&self) -> bool {
		self.result.is_some() || self.finished || self.cancelled || self.returned || self.exited
	}
}

/// The FIFO an open started on, pinned so that the open and its release
/// reach it ([`FifoOpen`]).
///
/// On Linux it holds an `O_PATH` descriptor of the FIFO, taken when the open
/// starts and kept until the open and its helper have ended. An `O_PATH`
/// open runs no `fifo_open`, so it is neither a reader nor a writer. While
/// it is open the FIFO's inode is not freed, so its number goes to no other
/// file (ext4 and overlayfs on it give a freed number to the next file made,
/// often the FIFO made at the same name: `rm p; mkfifo p`).
///
/// Elsewhere (macOS) a FIFO cannot be held without opening one of its ends,
/// so the pin is the (device, inode) of a `stat`, which a FIFO made later at
/// a reused number would share (APFS does not reuse numbers soon).
pub(crate) struct FifoPin {
	dev: u64,
	ino: u64,
	#[cfg(target_os = "linux")]
	fd:  Option<OwnedFd>,
}

#[allow(clippy::unnecessary_cast, reason = "stat field widths differ by platform")]
impl FifoPin {
	/// Pins the FIFO `name` names relative to the directory `dir`
	/// (`AT_FDCWD` for a path), following a final symlink only with
	/// `follow`. `Ok(None)` when it is no FIFO.
	#[cfg(target_os = "linux")]
	pub(crate) fn at(dir: RawFd, name: &CStr, follow: bool) -> io::Result<Option<Self>> {
		let flags = libc::O_PATH | libc::O_CLOEXEC | if follow { 0 } else { libc::O_NOFOLLOW };
		// SAFETY: `name` is NUL-terminated.
		let raw = unsafe { libc::openat(dir, name.as_ptr(), flags) };
		if raw < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `raw` was just opened, and nothing else owns it.
		let fd = unsafe { OwnedFd::from_raw_fd(raw) };
		let st = fstat(fd.as_fd())?;
		let pin =
			is_fifo(&st).then(|| Self { dev: st.st_dev as u64, ino: st.st_ino as u64, fd: Some(fd) });
		#[cfg(test)]
		if pin.is_some() {
			seam::fire_after_pin();
		}
		Ok(pin)
	}

	/// Pins the FIFO `name` names relative to the directory `dir`
	/// (`AT_FDCWD` for a path), following a final symlink only with
	/// `follow`. `Ok(None)` when it is no FIFO.
	#[cfg(not(target_os = "linux"))]
	pub(crate) fn at(dir: RawFd, name: &CStr, follow: bool) -> io::Result<Option<Self>> {
		let st = stat_at(dir, name, follow)?;
		let pin = is_fifo(&st).then_some(Self { dev: st.st_dev as u64, ino: st.st_ino as u64 });
		#[cfg(test)]
		if pin.is_some() {
			seam::fire_after_pin();
		}
		Ok(pin)
	}

	/// The FIFO a `stat` described as `meta`, with no descriptor: the drop
	/// then reaches it by its name, while the name names it.
	fn described(meta: &fs::Metadata) -> Self {
		Self {
			dev: meta.dev(),
			ino: meta.ino(),
			#[cfg(target_os = "linux")]
			fd: None,
		}
	}

	const fn id(&self) -> (u64, u64) {
		(self.dev, self.ino)
	}

	/// `/proc/self/fd/N` of the pin, where the drop reaches the FIFO, and the
	/// helper too unless the open has `O_CREAT`; `None` off Linux, without
	/// `/proc`, and for a pin with no descriptor, when they open the name.
	#[cfg_attr(
		not(target_os = "linux"),
		allow(
			clippy::unused_self,
			clippy::missing_const_for_fn,
			reason = "only Linux has a reopen path"
		)
	)]
	fn reopen_path(&self) -> Option<PathBuf> {
		#[cfg(target_os = "linux")]
		{
			static PROC_FD: std::sync::LazyLock<bool> =
				std::sync::LazyLock::new(|| Path::new("/proc/self/fd").is_dir());
			#[cfg(test)]
			if seam::by_name() {
				return None;
			}
			let fd = self.fd.as_ref()?;
			if !*PROC_FD {
				return None;
			}
			let path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
			// The magic link reaches the pin: `/proc` is this process's.
			fs::metadata(&path)
				.is_ok_and(|m| (m.dev(), m.ino()) == self.id())
				.then_some(path)
		}
		#[cfg(not(target_os = "linux"))]
		None
	}

	/// Whether `fd` is of the pinned FIFO.
	#[allow(clippy::unnecessary_cast, reason = "stat field widths differ by platform")]
	fn is(&self, fd: BorrowedFd<'_>) -> bool {
		fstat(fd).is_ok_and(|st| (st.st_dev as u64, st.st_ino as u64) == self.id())
	}
}

/// How the name of the FIFO an open started on is reached: by the helper
/// of an open that goes by name, and by the drop where no pin's
/// `/proc/self/fd/N` reaches the FIFO.
pub(crate) enum FifoName {
	/// A path, from the working directory, a final symlink followed only
	/// with `follow`.
	Path { path: PathBuf, follow: bool },
	/// An entry of a directory, a symlink there never followed.
	At { dir: OwnedFd, name: CString },
}

impl FifoName {
	/// The entry `name` of the directory `dir`, which is duplicated.
	pub(crate) fn at(dir: BorrowedFd<'_>, name: &[u8]) -> io::Result<Self> {
		let name = CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
		Ok(Self::At { dir: dir.try_clone_to_owned()?, name })
	}

	/// The path a helper that goes by name is handed (an entry's name, for a
	/// directory entry, whose open is the caller's own).
	fn path(&self) -> &Path {
		match self {
			Self::Path { path, .. } => path,
			Self::At { name, .. } => Path::new(OsStr::from_bytes(name.as_bytes())),
		}
	}

	fn dir_and_name(&self) -> io::Result<(RawFd, CString, bool)> {
		match self {
			Self::Path { path, follow } => Ok((
				libc::AT_FDCWD,
				CString::new(path.as_os_str().as_bytes())
					.map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?,
				*follow,
			)),
			Self::At { dir, name } => {
				use std::os::fd::AsRawFd as _;
				Ok((dir.as_raw_fd(), name.clone(), false))
			},
		}
	}

	/// Whether the name names the file `pin` pinned.
	#[allow(clippy::unnecessary_cast, reason = "stat field widths differ by platform")]
	fn names(&self, pin: &FifoPin) -> bool {
		self.dir_and_name().is_ok_and(|(dir, name, follow)| {
			stat_at(dir, &name, follow)
				.is_ok_and(|st| (st.st_dev as u64, st.st_ino as u64) == pin.id())
		})
	}

	/// Opens the FIFO at the name without blocking, with `access`
	/// (`O_RDONLY`, `O_WRONLY` or `O_RDWR`).
	fn open_without_wait(&self, access: libc::c_int) -> io::Result<fs::File> {
		let (dir, name, follow) = self.dir_and_name()?;
		let flags =
			access | libc::O_NONBLOCK | libc::O_CLOEXEC | if follow { 0 } else { libc::O_NOFOLLOW };
		// SAFETY: `name` is NUL-terminated.
		let raw = unsafe { libc::openat(dir, name.as_ptr(), flags) };
		if raw < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `raw` was just opened, and nothing else owns it.
		Ok(fs::File::from(unsafe { OwnedFd::from_raw_fd(raw) }))
	}
}

/// The FIFO an open started on, which its helper opens and its drop
/// releases.
struct Node {
	/// The FIFO the open started on; `None` when it was gone, or no FIFO, by
	/// the pin (only through [`FifoOpen::start_pinned`]: [`FifoOpen::start`]
	/// pins what its `meta` describes): nothing identifies it, and nothing
	/// releases the open.
	pin:       Option<FifoPin>,
	/// The pin's `/proc/self/fd/N`, when it reaches the pin.
	reopen:    Option<PathBuf>,
	/// The FIFO's name.
	name:      FifoName,
	/// The helper opens through `reopen`; else it opens the name.
	reopens:   bool,
	/// The open truncates (`O_TRUNC`), which the helper applies itself to
	/// what its open of the name returns (see [`FifoOpen`]).
	truncates: bool,
}

impl Node {
	/// The node at `path`, which `meta` describes, for an open that
	/// `creates` (has `O_CREAT`) or not. With `nofollow` a symbolic link at
	/// `path` is not pinned, so the helper's own open of the path refuses it.
	fn new(path: &Path, meta: &fs::Metadata, nofollow: bool, creates: bool) -> Self {
		let pin = CString::new(path.as_os_str().as_bytes())
			.ok()
			.and_then(|c_path| {
				FifoPin::at(libc::AT_FDCWD, &c_path, !nofollow)
					.ok()
					.flatten()
			})
			.unwrap_or_else(|| FifoPin::described(meta));
		Self::pinned(
			Some(pin),
			FifoName::Path { path: path.to_path_buf(), follow: !nofollow },
			creates,
		)
	}

	/// The node pinned as `pin`, at `name`; the helper opens the name when
	/// the open `creates` (has `O_CREAT`).
	fn pinned(pin: Option<FifoPin>, name: FifoName, creates: bool) -> Self {
		let reopen = pin.as_ref().and_then(FifoPin::reopen_path);
		let reopens = reopen.is_some() && !creates;
		#[cfg(test)]
		seam::note_helper(if reopens {
			seam::Helper::Reopen
		} else {
			seam::Helper::ByName
		});
		Self { pin, reopen, name, reopens, truncates: false }
	}

	/// What the helper opens, and whether it is the pin's `/proc/self/fd/N`.
	fn helper_path(&self) -> (&Path, bool) {
		if self.reopens
			&& let Some(reopen) = &self.reopen
		{
			(reopen, true)
		} else {
			(self.name.path(), false)
		}
	}

	/// Opens the pinned FIFO for reading and writing without blocking: the
	/// drop's peer ([`Node::open_pinned`]).
	fn peer(&self) -> Option<fs::File> {
		self.open_pinned(libc::O_RDWR)
	}

	/// Opens the pinned FIFO without blocking, with `access`: `O_RDWR` for
	/// the drop's peer, `O_RDONLY` for the look ([`waiting_bytes`]) and
	/// `O_WRONLY` for its wake-up ([`wake_helper`]). Through the pin's
	/// `/proc/self/fd/N`, else by name while the name names the pinned FIFO.
	/// `None` when nothing is pinned, or when the open fails or reaches
	/// another file.
	fn open_pinned(&self, access: libc::c_int) -> Option<fs::File> {
		let pin = self.pin.as_ref()?;
		let end = if let Some(reopen) = &self.reopen {
			fs::OpenOptions::new()
				.read(access != libc::O_WRONLY)
				.write(access != libc::O_RDONLY)
				.custom_flags(libc::O_NONBLOCK)
				.open(reopen)
				.ok()?
		} else {
			if !self.name.names(pin) {
				return None;
			}
			// The hook is the drop's peer's.
			#[cfg(test)]
			if access == libc::O_RDWR {
				hooks::run_before_peer_open(self.name.path());
			}
			self.name.open_without_wait(access).ok()?
		};
		// An end of another FIFO is closed at once.
		pin.is(end.as_fd()).then_some(end)
	}

	/// Whether the drop keeps waiting for a helper that opens the name: while
	/// the name names the pinned FIFO.
	fn name_names_pin(&self) -> bool {
		self.pin.as_ref().is_some_and(|pin| self.name.names(pin))
	}
}

#[cfg(test)]
impl Node {
	/// The `/proc/self/fd/N` both reach, or the path, as before the name
	/// could be told apart from the pin.
	fn path(&self) -> &Path {
		self.reopen.as_deref().unwrap_or_else(|| self.name.path())
	}
}

impl<T: TruncateRegular + Send + 'static> FifoOpen<T> {
	/// Starts opening the FIFO at `path`, which `meta` describes, on a helper
	/// thread, which calls `open` with the path to open and whether that path
	/// is a pin's `/proc/self/fd/N`. That path is a symbolic link, which the
	/// open must follow, so with it the open drops `O_NOFOLLOW`; with
	/// `nofollow` a symbolic link at `path` is never pinned, so `open`'s own
	/// `O_NOFOLLOW` open of the path refuses it. An open that `creates` (has
	/// `O_CREAT`) is handed `path` itself and `false`, never the pin (see
	/// [`FifoOpen`]). For an open that `truncates` (a write with `O_TRUNC`),
	/// `open` must leave `O_TRUNC` out when it is handed the path: the helper
	/// truncates what it returns, while the open is live (see [`FifoOpen`]).
	/// When the helper cannot be started, its error is the open's result.
	pub fn start<F>(
		path: &Path,
		meta: &fs::Metadata,
		nofollow: bool,
		creates: bool,
		truncates: bool,
		open: F,
	) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
	{
		Self::start_node(Node { truncates, ..Node::new(path, meta, nofollow, creates) }, open, None)
	}

	/// [`FifoOpen::start`] for a read-only open, which truncates nothing,
	/// that under gVisor ([`on_gvisor`]) does not depend on its `open(2)`
	/// being woken (see [`FifoOpen`]): a read end the look finds is made the
	/// open's result by `adopt`. Elsewhere it is [`FifoOpen::start`].
	pub fn start_reading<F, A>(
		path: &Path,
		meta: &fs::Metadata,
		nofollow: bool,
		creates: bool,
		open: F,
		adopt: A,
	) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
		A: FnOnce(fs::File) -> io::Result<T> + Send + 'static,
	{
		Self::start_reading_on(path, meta, nofollow, creates, open, adopt, on_gvisor())
	}

	/// [`FifoOpen::start_reading`] as on gVisor (`gvisor`) or elsewhere.
	fn start_reading_on<F, A>(
		path: &Path,
		meta: &fs::Metadata,
		nofollow: bool,
		creates: bool,
		open: F,
		adopt: A,
		gvisor: bool,
	) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
		A: FnOnce(fs::File) -> io::Result<T> + Send + 'static,
	{
		Self::start_node(Node::new(path, meta, nofollow, creates), open, looked_at(adopt, gvisor))
	}

	/// Starts opening the FIFO pinned as `pin` (`None`: nothing was pinned,
	/// and nothing releases the open) at `name`, on a helper thread. `open`
	/// is called as for [`FifoOpen::start`]: with the pin's `/proc/self/fd/N`
	/// and `true`, or, when the open `creates` (has `O_CREAT`) or no
	/// `/proc/self/fd/N` reaches the pin, with the name's path and `false`
	/// (an entry's name for a directory entry: `open` opens it in its own
	/// directory), and then without `O_TRUNC`, which the helper applies for
	/// an open that `truncates`.
	pub(crate) fn start_pinned<F>(
		pin: Option<FifoPin>,
		name: FifoName,
		creates: bool,
		truncates: bool,
		open: F,
	) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
	{
		Self::start_node(Node { truncates, ..Node::pinned(pin, name, creates) }, open, None)
	}

	/// [`FifoOpen::start_pinned`] for a read-only open, which truncates
	/// nothing, that under gVisor does not depend on its `open(2)` being
	/// woken, as [`FifoOpen::start_reading`]. With no pin nothing identifies
	/// the FIFO, so it is not looked at.
	pub(crate) fn start_pinned_reading<F, A>(
		pin: Option<FifoPin>,
		name: FifoName,
		creates: bool,
		open: F,
		adopt: A,
	) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
		A: FnOnce(fs::File) -> io::Result<T> + Send + 'static,
	{
		Self::start_node(Node::pinned(pin, name, creates), open, looked_at(adopt, on_gvisor()))
	}

	fn start_node<F>(node: Node, open: F, adopt: Option<Adopt<T>>) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
	{
		let node = Arc::new(node);
		// Not looked at with nothing pinned (nothing identifies the FIFO), nor
		// once `MAX_LEFT` helpers are left: the open waits on its helper
		// alone, as before.
		let look = adopt
			.filter(|_| {
				node.pin.is_some() && may_look(LEFT.load(std::sync::atomic::Ordering::Relaxed))
			})
			.map(|adopt| Look::new(Arc::clone(&node), adopt));
		let shared = Arc::new(Shared {
			slot: Mutex::new(Slot { look, ..Slot::default() }),
			done: Condvar::new(),
		});
		let helper = match spawn_helper(Arc::clone(&shared), Arc::clone(&node), open) {
			Ok(helper) => Some(helper),
			Err(e) => {
				let mut s = shared.slot.lock();
				s.result = Some(Err(e));
				s.exited = true;
				drop(s);
				None
			},
		};
		Self { shared, node, helper }
	}
}

/// The look's `adopt` for a read-only open: only on gVisor (`gvisor`).
fn looked_at<T, A>(adopt: A, gvisor: bool) -> Option<Adopt<T>>
where
	A: FnOnce(fs::File) -> io::Result<T> + Send + 'static,
{
	gvisor.then(|| Box::new(adopt) as Adopt<T>)
}

impl<T: Send + 'static> Looked for Shared<T> {
	/// While the helper is in `open(2)`: a look ([`Shared::look`]). Once the
	/// look took the open: a wake-up of the helper ([`Shared::wake`]).
	fn step(&self) -> Option<Duration> {
		let waking = self.slot.lock().look.as_ref()?.adopt.is_none();
		if waking { self.wake() } else { self.look() }
	}
}

impl<T: Send + 'static> Shared<T> {
	/// One look: the look's read end of the pinned FIFO (opened by the first
	/// look) is asked how many bytes wait in the FIFO. None: the end is kept,
	/// and the next look is due twice as late, up to [`LAST_PROBE`]. Some: a
	/// writer came, so the end, made blocking, becomes the open's result
	/// through `adopt`, and the wake-ups of the helper start. Over once the
	/// open is.
	fn look(&self) -> Option<Duration> {
		let (node, held) = {
			let mut s = self.slot.lock();
			let over = s.over();
			let look = s.look.as_mut()?;
			if over {
				drop(look.held.take());
				return None;
			}
			let node = Arc::clone(&look.node);
			let held = look.held.take();
			#[cfg(test)]
			{
				s.looks += 1;
			}
			s.looking = true;
			(node, held)
		};
		let held = held.or_else(|| node.open_pinned(libc::O_RDONLY));
		#[cfg(test)]
		{
			let mut s = self.slot.lock();
			while s.pause {
				s.paused = true;
				self.done.wait_for(&mut s, Duration::from_millis(10));
			}
			s.paused = false;
		}
		let found = held
			.as_ref()
			.is_some_and(|end| bytes_wait(end) && made_blocking(end));
		let mut s = self.slot.lock();
		let over = s.over();
		if !found || over {
			// Kept for the next look; closed under the lock once the open is
			// over.
			let wait = match s.look.as_mut() {
				Some(look) if !over => {
					look.held = held;
					look.wait = (look.wait * 2).min(LAST_PROBE);
					Some(look.wait)
				},
				_ => {
					drop(held);
					None
				},
			};
			s.looking = false;
			drop(s);
			self.done.notify_all();
			return wait;
		}
		let adopt = s.look.as_mut().and_then(|look| look.adopt.take());
		drop(s);
		// Still `looking`: a drop waits for this step, so the end never
		// outlives it.
		let adopted = held.zip(adopt).map(|(end, adopt)| adopt(end));
		let mut s = self.slot.lock();
		s.looking = false;
		let (wait, waker) = match adopted {
			Some(Ok(result)) if !s.over() => {
				s.result = Some(Ok(result));
				s.rescued = true;
				if let Some(look) = s.look.as_mut() {
					look.wakes = WAKES;
				}
				(Some(Duration::ZERO), s.waker.take())
			},
			// The open ended meanwhile, or the end was not adopted: what the
			// look got is closed.
			other => {
				drop(other);
				(None, None)
			},
		};
		drop(s);
		self.done.notify_all();
		if let Some(w) = waker {
			w.wake();
		}
		wait
	}

	/// One wake-up of a helper still in `open(2)` once the look took the
	/// open: a write end of the pinned FIFO that does not wait, opened and
	/// closed (the helper is a reader, so the open succeeds). At most
	/// [`WAKES`], [`WAKE_GAP`] apart, until the helper's `open(2)` returns,
	/// the helper ends or the open is dropped. A helper gVisor leaves asleep
	/// each time stays until a writer comes, then closes what it gets.
	fn wake(&self) -> Option<Duration> {
		let node = {
			let mut s = self.slot.lock();
			if s.returned || s.exited || s.cancelled {
				return None;
			}
			let look = s.look.as_mut()?;
			look.wakes = look.wakes.checked_sub(1)?;
			let node = Arc::clone(&look.node);
			s.looking = true;
			node
		};
		drop(node.open_pinned(libc::O_WRONLY));
		let mut s = self.slot.lock();
		s.looking = false;
		let more = !s.returned
			&& !s.exited
			&& !s.cancelled
			&& s.look.as_ref().is_some_and(|look| look.wakes > 0);
		drop(s);
		self.done.notify_all();
		more.then_some(WAKE_GAP)
	}
}

/// Whether bytes wait in the FIFO `end` reads.
fn bytes_wait(end: &fs::File) -> bool {
	use std::os::fd::AsRawFd as _;
	let mut waiting: libc::c_int = 0;
	// SAFETY: FIONREAD writes one int through the pointer, which outlives the
	// call; the descriptor is `end`'s, open.
	let asked = unsafe { libc::ioctl(end.as_raw_fd(), libc::FIONREAD as _, &raw mut waiting) };
	asked >= 0 && waiting > 0
}

/// Makes `end` blocking, as the helper's open would leave it; false when it
/// cannot.
fn made_blocking(end: &fs::File) -> bool {
	use std::os::fd::AsRawFd as _;
	let fd = end.as_raw_fd();
	// SAFETY: F_GETFL reads the status flags of our own open descriptor.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	// SAFETY: F_SETFL sets the status flags of our own open descriptor.
	flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } >= 0
}

/// What a FIFO open's `open` returns: a file its helper can truncate.
///
/// For a write that asks for `O_TRUNC`, the helper's open of the name leaves
/// it out, and the helper applies it itself under the open's lock, only while
/// the open has not been dropped, so a helper the drop has left truncates
/// nothing (see [`FifoOpen`]).
pub trait TruncateRegular {
	/// Truncates the file to no bytes when it is a regular file, as
	/// `O_TRUNC` does; anything else (the FIFO, a device) is left as it is.
	fn truncate_regular(&self) -> io::Result<()>;
}

impl TruncateRegular for fs::File {
	fn truncate_regular(&self) -> io::Result<()> {
		if self.metadata()?.is_file() {
			self.set_len(0)?;
		}
		Ok(())
	}
}

impl TruncateRegular for crate::File {
	fn truncate_regular(&self) -> io::Result<()> {
		if self.metadata()?.is_file() {
			self.set_len(0)?;
		}
		Ok(())
	}
}

impl<T> FifoOpen<T> {
	/// The open's result once the helper has it; until then `Pending`, and
	/// `cx` is woken when it has.
	pub fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
		let mut s = self.shared.slot.lock();
		if let Some(result) = s.result.take() {
			s.finished = true;
			return Poll::Ready(result);
		}
		if !s.waker.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
			s.waker = Some(cx.waker().clone());
		}
		Poll::Pending
	}

	/// The open's result, once the helper has it or `timeout` has passed.
	/// `done` is notified for more than the result (each step of the look
	/// notifies it), so the wait goes on until the result or the deadline.
	pub fn wait_for(&mut self, timeout: Duration) -> Option<io::Result<T>> {
		let deadline = Instant::now() + timeout;
		let mut s = self.shared.slot.lock();
		while s.result.is_none() && !self.shared.done.wait_until(&mut s, deadline).timed_out() {}
		let result = s.result.take();
		s.finished |= result.is_some();
		result
	}
}

/// Marks the helper ended when it returns or unwinds. A helper the drop
/// left before its last check ends here without an `open(2)`: it stops
/// counting in [`LEFT`] here.
struct Exit<T>(Arc<Shared<T>>);

impl<T> Drop for Exit<T> {
	fn drop(&mut self) {
		{
			let mut s = self.0.slot.lock();
			s.exited = true;
			stop_counting(&mut s);
		}
		self.0.done.notify_all();
	}
}

/// The helper is out of `open(2)`: a helper the drop left stops counting in
/// [`LEFT`].
fn helper_returned<T>(s: &mut Slot<T>) {
	s.returned = true;
	stop_counting(s);
}

/// A helper the drop left ([`Slot::counted`]) stops counting in [`LEFT`].
fn stop_counting<T>(s: &mut Slot<T>) {
	if s.counted {
		s.counted = false;
		LEFT.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
	}
}

/// Starts the thread that opens `node` with `open`, unless the open is
/// cancelled before it gets there.
///
/// The thread starts with every signal blocked but those a fault raises in
/// the faulting thread itself ([`SignalsBlocked`]): a signal sent to the
/// process then goes to a thread of the caller's that takes it, never to
/// this one, which would record it late (a shell's handler only records a
/// signal, and its main thread may act on later input first).
fn spawn_helper<T, F>(
	shared: Arc<Shared<T>>,
	node: Arc<Node>,
	open: F,
) -> io::Result<thread::JoinHandle<()>>
where
	T: TruncateRegular + Send + 'static,
	F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
{
	// The new thread inherits the calling thread's mask, so it never runs
	// with the signals open; the guard restores the caller's mask.
	let _blocked = SignalsBlocked::new();
	thread::Builder::new()
		.name("fifo-open".to_owned())
		.stack_size(64 << 10)
		.spawn(move || {
			let _exit = Exit(Arc::clone(&shared));
			#[cfg(test)]
			let _end = hooks::End(node.name.path().to_path_buf());
			#[cfg(test)]
			let after = seam::before_open();
			let first = {
				let mut s = shared.slot.lock();
				if s.cancelled {
					drop(s);
					#[cfg(test)]
					if let Some(after) = after {
						after(false);
					}
					return;
				}
				s.opening = true;
				#[cfg(test)]
				{
					if let (Some(first), Some(look)) = (s.first, s.look.as_mut()) {
						look.wait = first;
					}
				}
				s.look.as_ref().map(|look| look.wait)
			};
			// The look's first step, due after its first wait, is the watch's
			// to make: the caller's thread has done nothing for it, and no
			// thread is started for it.
			if let Some(first) = first
				&& !WATCH.add(Arc::downgrade(&shared) as Weak<dyn Looked>, first)
			{
				shared.slot.lock().look = None;
			}
			#[cfg(test)]
			{
				let seam_hold = seam::reached_after_check();
				let held = || {
					let s = shared.slot.lock();
					(s.hold || seam_hold) && (s.hold_long || (!s.joining && !s.left))
				};
				while held() {
					thread::yield_now();
				}
				let probe = shared.slot.lock().probe;
				if let Some(probe) = probe {
					let peer_held = probe(node.path());
					shared.slot.lock().peer_held = Some(peer_held);
					if !peer_held {
						return;
					}
				}
				if shared.slot.lock().stuck {
					// A reader that `open(2)` left asleep: registered, never
					// woken by the writer.
					let asleep = fs::OpenOptions::new()
						.read(true)
						.custom_flags(libc::O_NONBLOCK)
						.open(node.path());
					let mut s = shared.slot.lock();
					while (s.result.is_none() && !s.finished && !s.cancelled) || s.stay {
						shared.done.wait_for(&mut s, Duration::from_millis(10));
					}
					let cancelled = s.cancelled;
					drop(s);
					drop(asleep);
					if cancelled {
						helper_returned(&mut shared.slot.lock());
						return;
					}
				}
			}
			{
				// The last check: a helper the drop has left opens nothing.
				let s = shared.slot.lock();
				if s.abandoned {
					drop(s);
					#[cfg(test)]
					if let Some(after) = after {
						after(false);
					}
					return;
				}
				#[cfg(test)]
				{
					let mut s = s;
					s.in_open = true;
				}
			}
			#[cfg(test)]
			hooks::run_before_open(node.name.path());
			let (path, pinned) = node.helper_path();
			let opened = catch_unwind(AssertUnwindSafe(|| open(path, pinned)))
				.unwrap_or_else(|_| Err(io::Error::other("the FIFO open panicked")));
			#[cfg(test)]
			if let Some(after) = after {
				after(opened.is_ok());
			}
			let mut s = shared.slot.lock();
			helper_returned(&mut s);
			// The look's end goes once the helper's `open(2)` returned: the
			// helper's end reads what the FIFO holds. Closed under the lock,
			// so a drop never finds it afterwards.
			if let Some(look) = s.look.as_mut() {
				drop(look.held.take());
			}
			if s.cancelled || s.result.is_some() || s.finished {
				// A helper whose open was dropped, or that the drop has left,
				// or whose open the look took (it missed its writer): what it
				// opened is closed here, unchanged.
				return;
			}
			// The caller's `O_TRUNC` for an open of the name, applied under
			// the lock: a drop that comes now waits for it, and one that came
			// first was seen above. A `poll` or `wait_for` of the open waits
			// for it too, and bytes written between the open and this are
			// lost (see [`FifoOpen`]).
			let opened = match opened {
				Ok(file) if node.truncates && !pinned => file.truncate_regular().map(|()| file),
				opened => opened,
			};
			s.result = Some(opened);
			let waker = s.waker.take();
			drop(s);
			shared.done.notify_all();
			if let Some(w) = waker {
				w.wake();
			}
		})
}

/// How long a drop waits for a helper that opens the name while the name
/// names the pinned FIFO (see [`FifoOpen`]). That helper's open of the pinned
/// FIFO ends at once, as the drop holds the FIFO's two ends; one that is
/// still waiting when this has passed waits on another FIFO.
pub(crate) const LEAVE_AFTER: Duration = Duration::from_secs(1);

/// Blocks every signal but [`SignalsBlocked::FAULTS`] in the calling thread
/// until dropped, which restores the mask it found.
struct SignalsBlocked(libc::sigset_t);

impl SignalsBlocked {
	/// The signals a fault raises in the thread that faults: never blocked.
	/// Linux delivers such a signal with its default action when the thread
	/// blocks it, so the process would die without a crash handler's report.
	const FAULTS: [libc::c_int; 6] =
		[libc::SIGSEGV, libc::SIGBUS, libc::SIGILL, libc::SIGFPE, libc::SIGTRAP, libc::SIGSYS];

	fn new() -> Self {
		// SAFETY: plain data, filled by sigfillset / pthread_sigmask.
		let mut blocked: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: as above.
		let mut old: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: both sets are valid for the calls, and each signal number
		// is a valid one.
		unsafe {
			libc::sigfillset(&raw mut blocked);
			for sig in Self::FAULTS {
				libc::sigdelset(&raw mut blocked, sig);
			}
			libc::pthread_sigmask(libc::SIG_BLOCK, &raw const blocked, &raw mut old);
		}
		Self(old)
	}
}

impl Drop for SignalsBlocked {
	fn drop(&mut self) {
		// SAFETY: the mask `new` read back from this thread.
		unsafe {
			libc::pthread_sigmask(libc::SIG_SETMASK, &raw const self.0, std::ptr::null_mut());
		}
	}
}

/// How long a drop waits for a helper the look took the open from to return
/// from its `open(2)` once the drop's own end is open: gVisor left it asleep
/// through its writer and the look's wake-ups, and may leave it asleep
/// through this one too ([`FifoOpen`]).
const RESCUED_JOIN: Duration = Duration::from_millis(100);

impl<T> Drop for FifoOpen<T> {
	/// See [`FifoOpen`]. A result the helper stored that was not taken is
	/// closed, and a helper that has not passed its check of the cancel opens
	/// nothing. Else the drop opens its peer (`Node::peer`) and waits for the
	/// helper to end, holding the peer. It leaves the helper instead, and
	/// returns:
	/// - when no peer opens: nothing is pinned, the peer's open fails (a FIFO
	///   this process may not open for both reading and writing), or it reaches
	///   no pinned FIFO (by name, the name names another file);
	/// - for a helper that opens the name: when the name names another file once
	///   the peer is open, and, while it waits, once the name names another file
	///   or [`LEAVE_AFTER`] has passed.
	///
	/// A helper the look took the open from ([`FifoOpen::start_reading`]) is
	/// released even when the open's result was taken, and is waited for
	/// only while it returns within [`RESCUED_JOIN`] once the peer is open;
	/// else it is left, and counts in [`LEFT`] until it ends. On Linux a
	/// writer's open wakes the helper, so a look does not take the open.
	///
	/// A helper it leaves opens nothing if it has not passed its last check.
	/// One in `open(2)` of the pinned FIFO is completed by the peer, where
	/// there is one, and closes what it got, maybe a moment after the drop
	/// returned; with no peer it waits until the FIFO's other end opens. One
	/// in `open(2)` of another FIFO waits there. Those helpers aside, the drop
	/// leaves no end of the FIFO behind once it returns: a step of the look
	/// in flight ends first, none starts after it, and the look's end is
	/// closed.
	fn drop(&mut self) {
		self.release();
		let mut s = self.shared.slot.lock();
		s.cancelled = true;
		while s.looking {
			self.shared.done.wait(&mut s);
		}
		if let Some(look) = s.look.as_mut() {
			drop(look.held.take());
		}
	}
}

impl<T> FifoOpen<T> {
	/// The drop's release of the helper ([`FifoOpen`]'s `Drop`).
	fn release(&mut self) {
		let rescued = {
			let mut s = self.shared.slot.lock();
			// A taken result leaves nothing to release, but for a helper whose
			// open the look took.
			if s.finished && !s.rescued {
				return;
			}
			s.cancelled = true;
			let unclaimed = s.result.take();
			if (unclaimed.is_some() && !s.rescued) || !s.opening {
				return;
			}
			s.rescued
		};
		// A helper the look took the open from that is out of `open(2)` ends
		// at once, closing what it got.
		if rescued && self.shared.slot.lock().returned {
			if let Some(helper) = self.helper.take() {
				let _ = helper.join();
			}
			return;
		}
		let peer = self.node.peer();
		#[cfg(test)]
		seam::after_release(peer.is_some());
		let (Some(peer), Some(helper)) = (peer, self.helper.take()) else {
			self.leave();
			return;
		};
		let by_name = !self.node.reopens;
		// A name that names another file now leaves the helper at once.
		if by_name && !self.node.name_names_pin() {
			self.leave();
			return;
		}
		#[cfg(test)]
		{
			self.shared.slot.lock().joining = true;
			hooks::run_when_joining(self.node.name.path());
		}
		if rescued {
			let deadline = Instant::now() + RESCUED_JOIN;
			let mut s = self.shared.slot.lock();
			while !s.returned
				&& !s.exited
				&& !self.shared.done.wait_until(&mut s, deadline).timed_out()
			{}
			if !s.returned && !s.exited {
				s.counted = true;
				LEFT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
				drop(s);
				self.leave();
				return;
			}
		}
		if by_name && !self.wait_by_name() {
			self.leave();
			return;
		}
		let _ = helper.join();
		drop(peer);
	}
}

impl<T> FifoOpen<T> {
	/// Gives the helper up: one that has not passed its last check opens
	/// nothing.
	fn leave(&self) {
		let mut s = self.shared.slot.lock();
		s.abandoned = true;
		#[cfg(test)]
		{
			s.left = true;
		}
	}

	/// For a helper that opens the name, while the drop holds the FIFO's two
	/// ends: whether the helper ends while the name names the pinned FIFO,
	/// within [`LEAVE_AFTER`]. The name is checked every [`POLL_SLICE`] at
	/// most.
	fn wait_by_name(&self) -> bool {
		let deadline = Instant::now() + LEAVE_AFTER;
		let mut s = self.shared.slot.lock();
		loop {
			if s.exited {
				return true;
			}
			drop(s);
			let named = self.node.name_names_pin();
			s = self.shared.slot.lock();
			if s.exited {
				return true;
			}
			let now = Instant::now();
			if !named || now >= deadline {
				return false;
			}
			self
				.shared
				.done
				.wait_for(&mut s, POLL_SLICE.min(deadline - now));
		}
	}
}

#[allow(clippy::unnecessary_cast, reason = "stat field widths differ by platform")]
fn fstat(fd: BorrowedFd<'_>) -> io::Result<libc::stat> {
	use std::os::fd::AsRawFd as _;
	let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `st` is a valid out-pointer.
	if unsafe { libc::fstat(fd.as_raw_fd(), st.as_mut_ptr()) } == -1 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `fstat` succeeded and filled `st`.
	Ok(unsafe { st.assume_init() })
}

/// `fstatat` of `name` in `dir`, a final symlink followed only with
/// `follow`.
fn stat_at(dir: RawFd, name: &CStr, follow: bool) -> io::Result<libc::stat> {
	let flag = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
	let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `name` is NUL-terminated and `st` is a valid out-pointer.
	if unsafe { libc::fstatat(dir, name.as_ptr(), st.as_mut_ptr(), flag) } == -1 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `fstatat` succeeded and filled `st`.
	Ok(unsafe { st.assume_init() })
}

const fn is_fifo(st: &libc::stat) -> bool {
	st.st_mode & libc::S_IFMT == libc::S_IFIFO
}

/// Test seams: a hook a test sets for the next FIFO helper, run on the
/// helper's thread before its check of the cancel (it may block, to hold the
/// helper back) and after its open (told whether the open succeeded; a
/// helper that finds the open cancelled opens nothing and is told `false`);
/// a hook run after each drop's open of its peer, while the peer is still
/// held (told whether it opened one); a hook run just after the next FIFO
/// pin is taken; a record of the way each FIFO's helper opens it; and a
/// switch that makes pinned FIFO opens open the name, as they do without
/// `/proc`.
#[cfg(test)]
pub(crate) mod seam {
	use std::sync::atomic::{AtomicBool, Ordering};

	use parking_lot::Mutex;

	type Before = Box<dyn FnOnce() + Send>;
	type After = Box<dyn FnOnce(bool) + Send>;
	type Release = Box<dyn FnMut(bool) + Send>;

	static NEXT: Mutex<Option<(Before, After)>> = Mutex::new(None);
	static RELEASE: Mutex<Option<Release>> = Mutex::new(None);
	static AFTER_PIN: Mutex<Option<Before>> = Mutex::new(None);
	static BY_NAME: AtomicBool = AtomicBool::new(false);
	static HELPERS: Mutex<Vec<Helper>> = Mutex::new(Vec::new());
	static AFTER_CHECK: Mutex<Option<(std::sync::mpsc::Sender<()>, bool)>> = Mutex::new(None);

	/// Has the next FIFO helper in this process tell `reached` once it has
	/// passed its check of the cancel, before its open; with `hold`, it then
	/// waits there until the drop is about to join it, or has returned
	/// without joining it.
	pub(crate) fn after_check(reached: std::sync::mpsc::Sender<()>, hold: bool) {
		*AFTER_CHECK.lock() = Some((reached, hold));
	}

	/// Tells the hook of [`after_check`], if one is set, and whether the
	/// helper is to hold there.
	pub(super) fn reached_after_check() -> bool {
		let Some((reached, hold)) = AFTER_CHECK.lock().take() else {
			return false;
		};
		let _ = reached.send(());
		hold
	}

	/// The way a FIFO's helper opens it.
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub(crate) enum Helper {
		/// By the name, with the caller's own options.
		ByName,
		/// Through the pin's `/proc/self/fd/N`, with the options for that.
		Reopen,
	}

	pub(super) fn note_helper(helper: Helper) {
		HELPERS.lock().push(helper);
	}

	/// The ways the FIFO helpers started in this process since the last
	/// call opened their FIFO, in order.
	#[cfg_attr(not(target_os = "linux"), allow(dead_code, reason = "only Linux tests read it"))]
	pub(crate) fn take_helpers() -> Vec<Helper> {
		std::mem::take(&mut *HELPERS.lock())
	}

	/// Makes pinned FIFO opens in this process from now on open the name and
	/// check what a drop opened, as without `/proc` (`on`), or not.
	pub(crate) fn open_by_name(on: bool) {
		BY_NAME.store(on, Ordering::SeqCst);
	}

	#[cfg_attr(not(target_os = "linux"), allow(dead_code, reason = "only Linux reopens"))]
	pub(super) fn by_name() -> bool {
		BY_NAME.load(Ordering::SeqCst)
	}

	/// Hooks the next FIFO helper that starts in this process.
	pub(crate) fn set(
		before: impl FnOnce() + Send + 'static,
		after: impl FnOnce(bool) + Send + 'static,
	) {
		*NEXT.lock() = Some((Box::new(before), Box::new(after)));
	}

	/// Runs the hook's first half, if one is set, and hands back its second.
	pub(super) fn before_open() -> Option<After> {
		let (before, after) = NEXT.lock().take()?;
		before();
		Some(after)
	}

	/// Hooks every drop's release in this process from now on.
	pub(crate) fn on_release(hook: impl FnMut(bool) + Send + 'static) {
		*RELEASE.lock() = Some(Box::new(hook));
	}

	pub(super) fn after_release(held: bool) {
		if let Some(hook) = RELEASE.lock().as_mut() {
			hook(held);
		}
	}

	/// Hooks the next FIFO pin taken in this process: `hook` runs just after
	/// the pin, before anything else of its open.
	#[cfg_attr(
		not(target_os = "linux"),
		allow(dead_code, reason = "only a Linux test renames a pinned FIFO")
	)]
	pub(crate) fn after_pin(hook: impl FnOnce() + Send + 'static) {
		*AFTER_PIN.lock() = Some(Box::new(hook));
	}

	pub(super) fn fire_after_pin() {
		let hook = AFTER_PIN.lock().take();
		if let Some(hook) = hook {
			hook();
		}
	}
}

/// Test hooks, keyed by the path an open's name gives: one run once by its
/// helper after its last check, just before its open (a stall, or a change
/// of what the name names); one run once by a drop's peer opened by name (no
/// `/proc/self/fd/N` reaches the pin), between its check that the name names
/// the pinned FIFO and its open of the name; one run once by a drop that has
/// its peer and did not leave the helper at once, whichever the helper opens,
/// before it waits for the helper; and a record of the helpers that have
/// ended.
#[cfg(test)]
pub(crate) mod hooks {
	use std::path::{Path, PathBuf};

	use parking_lot::Mutex;

	type Hook = (PathBuf, Box<dyn FnOnce() + Send>);

	static BEFORE_OPEN: Mutex<Vec<Hook>> = Mutex::new(Vec::new());
	static BEFORE_PEER_OPEN: Mutex<Vec<Hook>> = Mutex::new(Vec::new());
	static WHEN_JOINING: Mutex<Vec<Hook>> = Mutex::new(Vec::new());
	static ENDED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

	/// Runs `hook` once, in the next helper of an open given `name`, just
	/// before its open.
	pub(crate) fn before_open(name: &Path, hook: impl FnOnce() + Send + 'static) {
		BEFORE_OPEN
			.lock()
			.push((name.to_path_buf(), Box::new(hook)));
	}

	pub(crate) fn run_before_open(name: &Path) {
		run(&BEFORE_OPEN, name);
	}

	/// Runs `hook` once, in the next peer opened by `name` (no
	/// `/proc/self/fd/N` reaches the pin), after its check that `name` names
	/// the pinned FIFO and before its open of `name`.
	pub(crate) fn before_peer_open(name: &Path, hook: impl FnOnce() + Send + 'static) {
		BEFORE_PEER_OPEN
			.lock()
			.push((name.to_path_buf(), Box::new(hook)));
	}

	pub(crate) fn run_before_peer_open(name: &Path) {
		run(&BEFORE_PEER_OPEN, name);
	}

	/// Runs `hook` once, in the next drop of an open given `name` that waits
	/// for its helper (it did not leave it at once), before it waits.
	pub(crate) fn when_joining(name: &Path, hook: impl FnOnce() + Send + 'static) {
		WHEN_JOINING
			.lock()
			.push((name.to_path_buf(), Box::new(hook)));
	}

	pub(crate) fn run_when_joining(name: &Path) {
		run(&WHEN_JOINING, name);
	}

	/// Takes the first hook of `hooks` given `name` and runs it.
	fn run(hooks: &Mutex<Vec<Hook>>, name: &Path) {
		let hook = {
			let mut hooks = hooks.lock();
			let at = hooks.iter().position(|(path, _)| path == name);
			at.map(|at| hooks.remove(at).1)
		};
		if let Some(hook) = hook {
			hook();
		}
	}

	/// Whether a helper of an open given `name` has ended.
	#[cfg_attr(not(target_os = "linux"), allow(dead_code, reason = "only Linux tests use it"))]
	pub(crate) fn ended(name: &Path) -> bool {
		ENDED.lock().iter().any(|path| path == name)
	}

	/// Records its helper as ended when dropped.
	pub(crate) struct End(pub(crate) PathBuf);

	impl Drop for End {
		fn drop(&mut self) {
			ENDED.lock().push(std::mem::take(&mut self.0));
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{
		io::{Read, Write},
		os::unix::ffi::OsStrExt,
		sync::atomic::{AtomicUsize, Ordering},
	};

	use super::*;

	/// A directory removed when dropped, holding a new FIFO `f`.
	struct Dir(PathBuf);

	impl Drop for Dir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn new_fifo() -> (Dir, PathBuf) {
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let dir = std::env::temp_dir().join(format!(
			"pi-vfs-fifo-{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, Ordering::Relaxed)
		));
		fs::create_dir(&dir).unwrap();
		let path = dir.join("f");
		make_fifo(&path);
		(Dir(dir), path)
	}

	fn make_fifo(path: &Path) {
		let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
		// SAFETY: `c` is a NUL-terminated string that outlives the call.
		assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo");
	}

	/// Whether the FIFO at `path` has a reader: a write-only open that does
	/// not wait fails with ENXIO when it has none. No other test's process
	/// spawn is under way meanwhile ([`crate::tests::SPAWNS`]), so an end this
	/// process closed is not seen in a copy.
	fn has_reader(path: &Path) -> bool {
		let _no_spawn = crate::tests::SPAWNS.read();
		match fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)
		{
			Ok(_) => true,
			Err(e) if e.raw_os_error() == Some(libc::ENXIO) => false,
			Err(e) => panic!("{e}"),
		}
	}

	/// Whether the FIFO at `path` has a writer: a reader that does not wait
	/// reads end of file when it has none, and would block when it has one.
	/// No other test's process spawn is under way meanwhile, as for
	/// [`has_reader`].
	fn has_writer(path: &Path) -> bool {
		let _no_spawn = crate::tests::SPAWNS.read();
		let mut reader = fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)
			.unwrap();
		match reader.read(&mut [0; 1]) {
			Ok(0) => false,
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => true,
			other => panic!("{other:?}"),
		}
	}

	fn read_end(path: &Path, _pinned: bool) -> io::Result<fs::File> {
		fs::OpenOptions::new().read(true).open(path)
	}

	fn write_end(path: &Path, _pinned: bool) -> io::Result<fs::File> {
		fs::OpenOptions::new().write(true).open(path)
	}

	type Open = fn(&Path, bool) -> io::Result<fs::File>;

	/// An open of `path` whose helper has passed its check of the cancel: one
	/// that `creates` (its helper opens the path) or not.
	fn opening(path: &Path, creates: bool, open: Open) -> FifoOpen<fs::File> {
		let opened = FifoOpen::start(path, &fs::metadata(path).unwrap(), false, creates, false, open);
		while !opened.shared.slot.lock().opening {
			thread::yield_now();
		}
		opened
	}

	fn helper(path: &Path, slot: Slot<fs::File>, creates: bool, open: Open) -> FifoOpen<fs::File> {
		started(path, slot, creates, open, false)
	}

	/// A read-only open of `path` that looks for a writer its helper missed
	/// ([`FifoOpen::start_reading`]), its slot starting as `slot`.
	fn reading(path: &Path, slot: Slot<fs::File>) -> FifoOpen<fs::File> {
		started(path, slot, false, read_end, true)
	}

	fn started(
		path: &Path,
		slot: Slot<fs::File>,
		creates: bool,
		open: Open,
		looked: bool,
	) -> FifoOpen<fs::File> {
		let node = Arc::new(Node::new(path, &fs::metadata(path).unwrap(), false, creates));
		let adopt: Adopt<fs::File> = Box::new(Ok);
		let look = looked.then(|| Look::new(Arc::clone(&node), adopt));
		let shared =
			Arc::new(Shared { slot: Mutex::new(Slot { look, ..slot }), done: Condvar::new() });
		let helper = spawn_helper(Arc::clone(&shared), Arc::clone(&node), open).unwrap();
		FifoOpen { shared, node, helper: Some(helper) }
	}

	/// Waits at most 10 s until nothing but the test holds `shared`: the
	/// helper has ended, and the watch holds the open only while one of its
	/// steps runs.
	fn released(shared: &Arc<Shared<fs::File>>) -> bool {
		let deadline = std::time::Instant::now() + Duration::from_secs(10);
		while Arc::strong_count(shared) > 1 {
			if std::time::Instant::now() >= deadline {
				return false;
			}
			thread::sleep(Duration::from_millis(1));
		}
		true
	}

	/// Reads `end` to its end of file: what it read, and when the end came.
	fn drain(mut end: fs::File) -> (Vec<u8>, std::time::Instant) {
		let mut got = Vec::new();
		end.read_to_end(&mut got).unwrap();
		(got, std::time::Instant::now())
	}

	/// Linux unchanged: a reader whose writer opens 2 s later waits for it,
	/// as a plain open does. The looks meanwhile find no bytes and change
	/// nothing: the result is the helper's.
	#[test]
	fn a_reader_waits_for_a_writer_two_seconds_late() {
		let (_dir, path) = new_fifo();
		let mut opened = reading(&path, Slot::default());
		assert!(opened.wait_for(Duration::from_secs(2)).is_none(), "the open ended with no writer");
		assert!(opened.shared.slot.lock().looks >= 3, "no look in 2 s");
		let mut writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
		writer.write_all(b"x").unwrap();
		let reader = opened
			.wait_for(Duration::from_secs(10))
			.expect("no result 10 s after the writer opened")
			.unwrap();
		drop(writer);
		assert_eq!(drain(reader).0, b"x");
		assert!(!opened.shared.slot.lock().rescued, "a look took the open");
	}

	/// Linux unchanged: a reader no writer comes for keeps waiting; the looks
	/// change nothing, and the drop still ends both threads and leaves no end
	/// of the FIFO.
	#[test]
	fn a_reader_with_no_writer_keeps_waiting() {
		let (_dir, path) = new_fifo();
		let mut opened = reading(&path, Slot::default());
		assert!(opened.wait_for(Duration::from_secs(3)).is_none(), "the open ended with no writer");
		assert!(opened.shared.slot.lock().looks >= 4, "no look in 3 s");
		assert!(!opened.shared.slot.lock().rescued);
		let shared = Arc::clone(&opened.shared);
		drop(opened);
		assert!(released(&shared), "the helper or the watch kept the open after the drop");
		assert!(!has_reader(&path), "a reader is left");
		assert!(!has_writer(&path), "a writer is left");
	}

	/// A release names gVisor by its `-gvisor` suffix only: gVisor's own
	/// (also with RDMA) does, and Linux distributions' and older gVisor's
	/// (`4.4.0`) do not.
	#[test]
	fn a_release_names_gvisor_by_its_suffix() {
		for release in ["4.19.0-gvisor", "5.15.0-gvisor"] {
			assert!(gvisor_release(release.as_bytes()), "{release} is gVisor's");
		}
		for release in ["6.8.0-1017-gcp", "6.12.0-generic", "4.4.0", "6.1.0-gvisor-like", ""] {
			assert!(!gvisor_release(release.as_bytes()), "{release} is not gVisor's");
		}
	}

	/// The probe gives this kernel's answer. The Jobs that run these tests set
	/// `PI_VFS_TEST_KERNEL` to `gvisor` or `linux` from the pod's runtime, not
	/// from uname; unset, nothing is checked.
	#[test]
	fn the_gvisor_probe_answers_for_this_kernel() {
		let Ok(kernel) = std::env::var("PI_VFS_TEST_KERNEL") else {
			eprintln!("UNKNOWN: PI_VFS_TEST_KERNEL is not set; nothing was checked");
			return;
		};
		assert_eq!(on_gvisor(), kernel == "gvisor", "the probe, with PI_VFS_TEST_KERNEL={kernel}");
	}

	/// A read-only open is looked at on gVisor only.
	#[test]
	fn a_read_only_open_is_looked_at_only_on_gvisor() {
		for gvisor in [false, true] {
			let (_dir, path) = new_fifo();
			let meta = fs::metadata(&path).unwrap();
			let opened = FifoOpen::start_reading_on(&path, &meta, false, false, read_end, Ok, gvisor);
			assert_eq!(
				opened.shared.slot.lock().look.is_some(),
				gvisor,
				"on gVisor {gvisor}: the look"
			);
		}
	}

	/// A reader of `path` that holds bytes a writer wrote and left: `ab` waits
	/// in the FIFO, which has no writer.
	fn leftover(path: &Path) -> fs::File {
		let other = fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)
			.unwrap();
		let mut writer = fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)
			.unwrap();
		writer.write_all(b"ab").unwrap();
		drop(writer);
		other
	}

	/// The kernel's rule the look must keep off gVisor: a plain blocking read
	/// open of a FIFO that holds bytes another reader left, with no writer,
	/// waits for a writer.
	#[test]
	fn a_plain_open_waits_though_another_reader_left_bytes() {
		let (_dir, path) = new_fifo();
		let other = leftover(&path);
		let at = path.clone();
		let (opened_tx, opened) = std::sync::mpsc::channel();
		let reader = thread::spawn(move || {
			let end = fs::OpenOptions::new().read(true).open(&at);
			let _ = opened_tx.send(());
			end
		});
		let waited = opened.recv_timeout(Duration::from_secs(1)).is_err();
		let writer = fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&path)
			.unwrap();
		let end = reader.join().unwrap();
		drop((writer, end, other));
		assert!(waited, "the plain open returned with no writer");
	}

	/// Off gVisor a read-only open keeps that rule: it waits for a writer
	/// though bytes another reader left wait in the FIFO.
	#[test]
	fn off_gvisor_a_reader_waits_though_another_reader_left_bytes() {
		let (_dir, path) = new_fifo();
		let other = leftover(&path);
		let meta = fs::metadata(&path).unwrap();
		let mut opened = FifoOpen::start_reading_on(&path, &meta, false, false, read_end, Ok, false);
		let took = opened.wait_for(Duration::from_secs(1)).is_some();
		// A writer ends the open.
		let writer = fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&path)
			.unwrap();
		let end = if took {
			None
		} else {
			opened.wait_for(Duration::from_secs(10))
		};
		drop((writer, end, opened, other));
		assert!(!took, "the open ended with bytes another reader left, and no writer");
	}

	/// On gVisor that is the look's limit: the first look takes bytes another
	/// reader left, with no writer.
	#[test]
	fn on_gvisor_a_look_takes_bytes_another_reader_left() {
		let (_dir, path) = new_fifo();
		let other = leftover(&path);
		let meta = fs::metadata(&path).unwrap();
		let mut opened = FifoOpen::start_reading_on(&path, &meta, false, false, read_end, Ok, true);
		let end = opened
			.wait_for(Duration::from_secs(10))
			.expect("no look took the open in 10 s")
			.unwrap();
		assert!(opened.shared.slot.lock().rescued, "the result is not the look's");
		drop((opened, other));
		assert_eq!(drain(end).0, b"ab");
	}

	/// An open that ends within the look's first wait is not looked at.
	/// The first wait is 10 s here (the `first` hook), so a loaded node that
	/// holds the writer back past [`FIRST_PROBE`] does not fail it.
	#[test]
	fn an_open_that_ends_within_the_first_wait_is_not_looked_at() {
		let (_dir, path) = new_fifo();
		let slot = Slot { first: Some(Duration::from_secs(10)), ..Slot::default() };
		let mut opened = reading(&path, slot);
		thread::sleep(Duration::from_millis(20));
		let writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
		let reader = opened
			.wait_for(Duration::from_secs(10))
			.expect("no result 10 s after the writer opened")
			.unwrap();
		assert_eq!(opened.shared.slot.lock().looks, 0, "the open was looked at");
		drop((writer, reader));
	}

	/// A helper left asleep after its writer wrote (the `stuck` hook, as
	/// gVisor leaves one) does not keep the open from its bytes: a look takes
	/// the open with its end made blocking, as the helper's would be, and
	/// the look's write opens wake the helper before the drop does; the
	/// helper closes what it gets.
	#[test]
	fn a_look_takes_an_open_whose_helper_was_left_asleep() {
		let (_dir, path) = new_fifo();
		let mut opened = reading(&path, Slot { stuck: true, ..Slot::default() });
		while !opened.shared.slot.lock().opening {
			thread::yield_now();
		}
		// The stuck helper holds a read end, so this open does not wait.
		let mut writer = loop {
			match fs::OpenOptions::new()
				.write(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&path)
			{
				Ok(writer) => break writer,
				Err(e) if e.raw_os_error() == Some(libc::ENXIO) => thread::yield_now(),
				Err(e) => panic!("{e}"),
			}
		};
		writer.write_all(b"ab").unwrap();
		drop(writer);
		let reader = opened
			.wait_for(Duration::from_secs(10))
			.expect("no result 10 s after the writer wrote")
			.unwrap();
		assert!(opened.shared.slot.lock().rescued, "the result is not the look's");
		// SAFETY: F_GETFL reads the status flags of the test's own descriptor.
		let flags = unsafe { libc::fcntl(std::os::fd::AsRawFd::as_raw_fd(&reader), libc::F_GETFL) };
		assert!(
			flags >= 0 && flags & libc::O_NONBLOCK == 0,
			"the look's end does not block: flags {flags:#o}"
		);
		assert_eq!(drain(reader).0, b"ab");
		// The look's write opens end the helper's `open(2)` before the drop,
		// whose own end would end it too.
		let deadline = std::time::Instant::now() + Duration::from_secs(10);
		while !opened.shared.slot.lock().returned {
			assert!(std::time::Instant::now() < deadline, "the look's wake-up did not end the open");
			thread::sleep(Duration::from_millis(10));
		}
		let shared = Arc::clone(&opened.shared);
		drop(opened);
		assert!(shared.slot.lock().returned, "the helper is still asleep");
		assert!(released(&shared), "the helper or the watch kept the open after the drop");
	}

	/// A drop that comes while a look has its end of the FIFO open (the
	/// `pause` hook holds the look there) waits for that look, and the end
	/// is closed when the drop returns.
	#[test]
	fn a_drop_waits_for_a_look_in_flight() {
		let (_dir, path) = new_fifo();
		let opened = reading(&path, Slot { pause: true, ..Slot::default() });
		let shared = Arc::clone(&opened.shared);
		let deadline = std::time::Instant::now() + Duration::from_secs(10);
		while !shared.slot.lock().paused {
			assert!(std::time::Instant::now() < deadline, "no look in 10 s");
			thread::sleep(Duration::from_millis(1));
		}
		let (sent, dropped) = std::sync::mpsc::channel();
		let dropper = thread::spawn(move || {
			drop(opened);
			let _ = sent.send(());
		});
		let waited = dropped.recv_timeout(Duration::from_millis(200)).is_err();
		shared.slot.lock().pause = false;
		shared.done.notify_all();
		let ended = dropped.recv_timeout(Duration::from_secs(10)).is_ok();
		dropper.join().unwrap();
		let reader_left = has_reader(&path);
		assert!(waited, "the drop did not wait for the look in flight");
		assert!(ended, "the drop did not return once the look went on");
		assert!(!reader_left, "the look's end outlived the drop");
	}

	/// The look's end goes once the helper's `open(2)` returns, not when the
	/// open is dropped: once the caller closes the helper's end, a writer of
	/// the FIFO has no reader and its write fails with `EPIPE`, as after a
	/// plain open.
	#[test]
	fn the_looks_end_closes_when_the_helpers_open_returns() {
		let (_dir, path) = new_fifo();
		let mut opened = reading(&path, Slot::default());
		let deadline = std::time::Instant::now() + Duration::from_secs(10);
		while {
			let s = opened.shared.slot.lock();
			s.looks == 0 || s.looking
		} {
			assert!(std::time::Instant::now() < deadline, "no look in 10 s");
			thread::sleep(Duration::from_millis(1));
		}
		assert!(
			opened
				.shared
				.slot
				.lock()
				.look
				.as_ref()
				.is_some_and(|look| look.held.is_some()),
			"the first look did not keep its end"
		);
		let mut writer = fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&path)
			.unwrap();
		let reader = opened
			.wait_for(Duration::from_secs(10))
			.expect("no result 10 s after the writer opened")
			.unwrap();
		assert!(!opened.shared.slot.lock().rescued, "a look took the open");
		drop(reader);
		let wrote = writer.write_all(b"x");
		drop((opened, writer));
		assert_eq!(
			wrote.as_ref().map_err(io::Error::kind).err(),
			Some(io::ErrorKind::BrokenPipe),
			"a write after the caller closed its end: {wrote:?}"
		);
	}

	/// A writer the look's read end lets out of `open(2)` has a reader to
	/// write to: the look keeps that end open until the open is over, and
	/// the writer's bytes become the open's result. The helper here never
	/// enters `open(2)` (the `hold` hook, as a helper thread descheduled
	/// after its check), so the look's end is the FIFO's only reader. The
	/// writer writes 200 ms after the first look let it go (at 50 ms), between
	/// the looks at 150 ms and 350 ms.
	#[test]
	fn a_writer_the_look_lets_go_has_a_reader() {
		let (_dir, path) = new_fifo();
		let mut opened = reading(&path, Slot { hold: true, ..Slot::default() });
		while !opened.shared.slot.lock().opening {
			thread::yield_now();
		}
		let writer = thread::spawn(move || -> io::Result<()> {
			// Waits for a reader: the look's end is the first.
			let mut writer = fs::OpenOptions::new().write(true).open(&path)?;
			thread::sleep(Duration::from_millis(200));
			writer.write_all(b"a\n")
		});
		let wrote = writer.join().unwrap();
		assert!(
			wrote.is_ok(),
			"the look let the writer go and closed its end before the helper was a reader: {wrote:?}"
		);
		let reader = opened
			.wait_for(Duration::from_secs(10))
			.expect("no result 10 s after the writer wrote")
			.unwrap();
		assert!(opened.shared.slot.lock().rescued, "the result is not the look's");
		assert_eq!(drain(reader).0, b"a\n", "the writer's bytes are not the open's");
	}

	/// The looks of every open are made by one thread for the process, not
	/// a thread per open: four opens that have each been looked at leave
	/// one thread named `fifo-watch`.
	#[cfg(target_os = "linux")]
	#[test]
	fn one_thread_looks_at_every_open() {
		let fifos: Vec<_> = (0..4).map(|_| new_fifo()).collect();
		let opens: Vec<_> = fifos
			.iter()
			.map(|(_, path)| reading(path, Slot::default()))
			.collect();
		for open in &opens {
			let deadline = std::time::Instant::now() + Duration::from_secs(10);
			while open.shared.slot.lock().looks == 0 {
				assert!(std::time::Instant::now() < deadline, "an open was not looked at in 10 s");
				thread::sleep(Duration::from_millis(10));
			}
		}
		let watchers = fs::read_dir("/proc/self/task")
			.unwrap()
			.filter_map(|task| fs::read_to_string(task.ok()?.path().join("comm")).ok())
			.filter(|comm| comm.trim_end() == "fifo-watch")
			.count();
		drop(opens);
		assert_eq!(watchers, 1, "threads named fifo-watch while four opens are looked at");
	}

	/// Lets a helper the `stay` hook holds go when dropped, so a test that
	/// fails before it lets the helper go fails instead of hanging in the
	/// drop's join. It holds no reference that counts: tests count them.
	struct LetGo(std::sync::Weak<Shared<fs::File>>);

	impl Drop for LetGo {
		fn drop(&mut self) {
			if let Some(shared) = self.0.upgrade() {
				shared.slot.lock().stay = false;
				shared.done.notify_all();
			}
		}
	}

	/// A drop does not wait for a helper the look took the open from when the
	/// drop's own end does not wake it either (the `stay` hook: gVisor leaves
	/// it asleep): the drop returns within a second, and the helper, once it
	/// returns, closes its end and leaves no reader.
	#[test]
	fn a_drop_leaves_a_helper_the_look_could_not_wake() {
		let (_dir, path) = new_fifo();
		let mut opened = reading(&path, Slot { stuck: true, stay: true, ..Slot::default() });
		let _let_go = LetGo(Arc::downgrade(&opened.shared));
		while !opened.shared.slot.lock().opening {
			thread::yield_now();
		}
		// The stuck helper opens its read end after it set `opening`: until
		// then a write open that does not wait fails with ENXIO.
		let mut writer = loop {
			match fs::OpenOptions::new()
				.write(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&path)
			{
				Ok(writer) => break writer,
				Err(e) if e.raw_os_error() == Some(libc::ENXIO) => thread::yield_now(),
				Err(e) => panic!("{e}"),
			}
		};
		writer.write_all(b"ab").unwrap();
		drop(writer);
		let reader = opened
			.wait_for(Duration::from_secs(10))
			.expect("no result 10 s after the writer wrote")
			.unwrap();
		assert!(opened.shared.slot.lock().rescued, "the result is not the look's");
		let shared = Arc::clone(&opened.shared);
		// The drop runs on its own thread: one that waits for the helper is
		// released after 2 s (the helper let go), so the test fails instead of
		// hanging.
		let (sent, done) = std::sync::mpsc::channel();
		let dropper = thread::spawn(move || {
			drop(opened);
			let _ = sent.send(());
		});
		let waited = done.recv_timeout(Duration::from_secs(2)).is_err();
		// Read before the helper is let go: once it returns it stops counting.
		let (returned_meanwhile, counted) = {
			let s = shared.slot.lock();
			(s.returned, s.counted)
		};
		shared.slot.lock().stay = false;
		shared.done.notify_all();
		dropper.join().unwrap();
		assert!(!waited, "the drop waited for a helper that does not wake");
		assert!(!returned_meanwhile, "the helper returned while it was held asleep");
		assert!(counted, "the left helper is not counted");
		let deadline = std::time::Instant::now() + Duration::from_secs(10);
		while Arc::strong_count(&shared) > 1 {
			assert!(std::time::Instant::now() < deadline, "the helper did not end once released");
			thread::sleep(Duration::from_millis(10));
		}
		assert!(shared.slot.lock().returned);
		assert!(!shared.slot.lock().counted, "the helper that returned still counts as left");
		assert_eq!(drain(reader).0, b"ab");
		assert!(!has_reader(&path), "a reader is left");
	}

	/// A helper the drop leaves counts in [`LEFT`] only until it ends, also
	/// one the drop leaves before its last check, which ends without an
	/// `open(2)`. The `hold` and `hold_long` hooks keep the helper after its
	/// check of the cancel through the drop's wait of [`RESCUED_JOIN`], so
	/// the drop leaves it; the count is read while it is held, then it is let
	/// go. In a process of its own, so no other test's helper moves [`LEFT`]
	/// meanwhile.
	#[test]
	fn a_helper_the_drop_leaves_stops_counting_when_it_ends() {
		if crate::dir_handle::alone(
			"fifo::tests::a_helper_the_drop_leaves_stops_counting_when_it_ends",
		) {
			return;
		}
		let left = || LEFT.load(std::sync::atomic::Ordering::Relaxed);
		let before = left();
		let (_dir, path) = new_fifo();
		let mut opened = reading(&path, Slot { hold: true, hold_long: true, ..Slot::default() });
		while !opened.shared.slot.lock().opening {
			thread::yield_now();
		}
		// The helper is not in `open(2)`: the look's end lets this writer go.
		let wp = path.clone();
		let writer = thread::spawn(move || -> io::Result<()> {
			let mut w = fs::OpenOptions::new().write(true).open(&wp)?;
			w.write_all(b"a\n")
		});
		writer.join().unwrap().unwrap();
		let reader = opened
			.wait_for(Duration::from_secs(10))
			.expect("no result 10 s after the writer wrote")
			.unwrap();
		assert!(opened.shared.slot.lock().rescued, "the look did not take the open");
		let shared = Arc::clone(&opened.shared);
		// The drop runs on its own thread: one that waits for the held helper
		// is released after 5 s (the helper let go), so the test fails instead
		// of hanging.
		let (sent, done) = std::sync::mpsc::channel();
		let dropper = thread::spawn(move || {
			drop(opened);
			let _ = sent.send(());
		});
		let waited = done.recv_timeout(Duration::from_secs(5)).is_err();
		let during = left();
		shared.slot.lock().hold_long = false;
		dropper.join().unwrap();
		assert!(!waited, "the drop waited for a helper held after its check");
		assert_eq!(during, before + 1, "the drop did not leave the helper");
		// A writer for a helper that goes on into `open(2)` once let go.
		let wp = path;
		thread::spawn(move || {
			let _ = fs::OpenOptions::new().write(true).open(&wp);
		});
		let deadline = std::time::Instant::now() + Duration::from_secs(10);
		while Arc::strong_count(&shared) > 1 {
			assert!(std::time::Instant::now() < deadline, "the helper did not end once let go");
			thread::sleep(Duration::from_millis(10));
		}
		drop(reader);
		assert_eq!(left(), before, "a helper the drop left still counts in LEFT after it ended");
	}

	/// Past [`MAX_LEFT`] helpers left, a read-only open is not looked at, so
	/// no more are left.
	#[test]
	fn no_look_past_the_left_helper_cap() {
		assert!(may_look(0));
		assert!(may_look(MAX_LEFT - 1));
		assert!(!may_look(MAX_LEFT));
	}

	/// The look's wake-up of a helper left asleep ends no other reader of
	/// the FIFO early: a reader waiting in `open(2)` for a writer that comes
	/// 300 ms later gets all of that writer's bytes, and its end of file only
	/// once the writer closed.
	#[test]
	fn a_look_ends_no_other_reader_before_its_writer() {
		let (_dir, path) = new_fifo();
		let other_path = path.clone();
		let other =
			thread::spawn(move || drain(fs::OpenOptions::new().read(true).open(&other_path).unwrap()));
		let opened = reading(&path, Slot { stuck: true, ..Slot::default() });
		thread::sleep(Duration::from_millis(300));
		let mut writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
		writer.write_all(b"x").unwrap();
		thread::sleep(Duration::from_millis(200));
		writer.write_all(b"y").unwrap();
		// Read before the close: the other reader's end of file may come
		// before this thread runs again.
		let closed = std::time::Instant::now();
		drop(writer);
		let (got, ended) = other.join().unwrap();
		drop(opened);
		assert!(ended >= closed, "the other reader read end of file before its writer closed");
		assert!(!got.is_empty(), "the other reader got none of its writer's bytes");
	}

	/// A helper that finds the open cancelled opens nothing: it ends
	/// (instead of waiting in `open(2)` for a writer) and leaves no reader.
	/// Until it ends, the FIFO is watched for the reader a helper that
	/// entered `open(2)` would be, so such a helper fails the test (and the
	/// watch's own write open lets it return) instead of waiting.
	#[test]
	fn a_helper_cancelled_before_its_check_opens_nothing() {
		let (_dir, path) = new_fifo();
		let mut opened = helper(&path, Slot { cancelled: true, ..Slot::default() }, false, read_end);
		let thread = opened.helper.take().unwrap();
		while !thread.is_finished() {
			assert!(!has_reader(&path), "the cancelled helper opened the FIFO");
			thread::yield_now();
		}
		thread.join().unwrap();
		assert!(!opened.shared.slot.lock().opening);
		assert!(!has_reader(&path));
	}

	/// A drop after the helper's check, whether the helper waits in
	/// `open(2)` already or not yet, has ended the helper and left no end of
	/// the FIFO when it returns: a helper that opens the pin, and one that
	/// opens the path (an open that creates).
	#[test]
	fn a_drop_after_the_check_ends_the_helper_before_it_returns() {
		for creates in [false, true] {
			for open in [read_end as Open, write_end] {
				let (_dir, path) = new_fifo();
				let opened = opening(&path, creates, open);
				let shared = Arc::clone(&opened.shared);
				drop(opened);
				assert_eq!(
					Arc::strong_count(&shared),
					1,
					"creates {creates}: the helper outlived the drop"
				);
				assert!(!has_reader(&path), "creates {creates}: a reader is left");
				assert!(!has_writer(&path), "creates {creates}: a writer is left");
			}
		}
	}

	/// A drop that comes while the helper is between its check and its
	/// `open(2)` holds its end of the FIFO until the helper has opened and
	/// closed. The helper here enters `open(2)` only once the drop is about
	/// to join it, and first looks for the drop's end: a drop that did not
	/// join leaves the helper waiting for it, and one that did not hold its
	/// end while it joined is seen without it. For a helper that opens the
	/// pin, and one that opens the path (an open that creates).
	#[test]
	fn a_drop_holds_its_end_until_a_helper_about_to_open_has_ended() {
		for creates in [false, true] {
			for (open, probe) in
				[(read_end as Open, has_writer as fn(&Path) -> bool), (write_end, has_reader)]
			{
				let (_dir, path) = new_fifo();
				let slot = Slot { hold: true, probe: Some(probe), ..Slot::default() };
				let opened = helper(&path, slot, creates, open);
				let shared = Arc::clone(&opened.shared);
				while !shared.slot.lock().opening {
					thread::yield_now();
				}
				drop(opened);
				assert_eq!(
					shared.slot.lock().peer_held,
					Some(true),
					"creates {creates}: the drop's end was not open when the helper opened"
				);
				assert_eq!(
					Arc::strong_count(&shared),
					1,
					"creates {creates}: the helper outlived the drop"
				);
				assert!(!has_reader(&path), "creates {creates}: a reader is left");
				assert!(!has_writer(&path), "creates {creates}: a writer is left");
			}
		}
	}

	/// An open the helper finished, which the caller never took, is closed
	/// by the drop, not when the last reference to the slot goes: the test
	/// holds one until it has checked.
	#[test]
	fn a_drop_closes_an_open_the_caller_never_took() {
		let (_dir, path) = new_fifo();
		let opened = opening(&path, false, read_end);
		let shared = Arc::clone(&opened.shared);
		// Be the writer the helper waits for, once it waits.
		let writer = loop {
			match fs::OpenOptions::new()
				.write(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&path)
			{
				Ok(writer) => break writer,
				Err(e) if e.raw_os_error() == Some(libc::ENXIO) => thread::yield_now(),
				Err(e) => panic!("{e}"),
			}
		};
		while shared.slot.lock().result.is_none() {
			thread::yield_now();
		}
		drop(writer);
		drop(opened);
		assert!(!has_reader(&path), "the helper's read end outlived the drop");
	}

	/// `wait_for` hands over the result the helper stored, once.
	#[test]
	fn wait_for_hands_over_the_result() {
		let (_dir, path) = new_fifo();
		let mut opened = opening(&path, false, read_end);
		let writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
		let reader = loop {
			if let Some(result) = opened.wait_for(Duration::from_secs(1)) {
				break result.unwrap();
			}
		};
		drop(writer);
		assert!(opened.wait_for(Duration::ZERO).is_none());
		drop(opened);
		assert!(has_reader(&path), "the reader the caller took was closed");
		drop(reader);
	}

	/// Where procfs reaches the pin (Linux with `/proc`), the drop reaches the
	/// node the open started on, though its path now names another FIFO, and
	/// the helper has ended when the drop returns. Without procfs the drop
	/// reaches the FIFO by its path, which names the other FIFO, so it leaves
	/// the helper (see [`FifoOpen`], "What is left"). A helper the drop leaves
	/// before its last check opens nothing; one past it waits on the old FIFO
	/// (or on the new one, had it not opened before the turn) until a writer
	/// of it opens, which this test then is. The path never names nothing: it
	/// reaches its FIFO through a symbolic link to a directory, which turns
	/// from the old FIFO's directory to the new one's in one `rename(2)`, so
	/// the helper's open of the path finds one FIFO or the other. In a moment
	/// with no file there, its open would fail with `ENOENT`, a result the
	/// drop takes without leaving the helper. Both FIFOs keep their names, so
	/// neither inode number can be reused for the other. (A hard link of a
	/// FIFO, the other way to keep the old one's name, failed with
	/// `EOPNOTSUPP` under gVisor.)
	#[cfg(target_os = "linux")]
	#[test]
	fn a_drop_releases_a_helper_whose_path_now_names_another_fifo() {
		let (dir, old) = new_fifo();
		let other = dir.0.join("b");
		fs::create_dir(&other).unwrap();
		make_fifo(&other.join("f"));
		// `l/f`, with `l` naming the directory itself: `old`.
		let link = dir.0.join("l");
		std::os::unix::fs::symlink(".", &link).unwrap();
		let path = link.join("f");
		let opened = opening(&path, false, read_end);
		let shared = Arc::clone(&opened.shared);
		let turned = dir.0.join("l.b");
		std::os::unix::fs::symlink("b", &turned).unwrap();
		fs::rename(&turned, &link).unwrap();
		drop(opened);
		if Path::new("/proc/self/fd").is_dir() {
			assert_eq!(Arc::strong_count(&shared), 1, "the helper outlived the drop");
			assert!(!has_reader(&path));
			return;
		}
		assert!(shared.slot.lock().left, "without procfs the drop did not leave the helper");
		// A writer of the FIFO the helper waits on ends its open; a writer's
		// open fails with ENXIO until the helper is in `open(2)`. The writers
		// stay open until the helper has ended.
		let mut writers = Vec::new();
		while Arc::strong_count(&shared) != 1 {
			for fifo in [&old, &path] {
				if let Ok(writer) = fs::OpenOptions::new()
					.write(true)
					.custom_flags(libc::O_NONBLOCK)
					.open(fifo)
				{
					writers.push(writer);
				}
			}
			thread::yield_now();
		}
		// A writer's open succeeds only once a reader is there, and the
		// helper is the only reader: writers were opened if and only if the
		// helper passed its last check.
		let in_open = shared.slot.lock().in_open;
		assert_eq!(!writers.is_empty(), in_open, "writers opened, against the helper's last check");
	}

	/// A drop that finds the name naming another file leaves a helper that
	/// opens the name at once, before it lets that helper go on: the helper,
	/// held after its first check until the drop waits for it or leaves it,
	/// finds the open left at its last check and opens nothing. A drop that
	/// went on to wait for the helper first would let it go on before it left
	/// it; the hook run when a drop waits holds such a drop until the helper
	/// has passed its last check, so the helper then opens the other FIFO, and
	/// the test fails. Where `/proc/self/fd` reaches the pin only (else the
	/// drop's peer goes by the name, which names another file, and the drop
	/// leaves before that check); elsewhere it checks nothing and says so.
	#[test]
	fn a_drop_leaves_at_once_a_helper_whose_name_names_another_fifo() {
		const LIMIT: Duration = Duration::from_secs(10);
		let (_dir, path) = new_fifo();
		let node = Arc::new(Node::new(&path, &fs::metadata(&path).unwrap(), false, true));
		if node.reopen.is_none() {
			eprintln!("UNKNOWN: no /proc/self/fd reaches the pin; nothing was checked");
			return;
		}
		let slot = Slot { hold: true, ..Slot::default() };
		let shared = Arc::new(Shared { slot: Mutex::new(slot), done: Condvar::new() });
		let helper = spawn_helper(Arc::clone(&shared), Arc::clone(&node), write_end).unwrap();
		let opened = FifoOpen { shared: Arc::clone(&shared), node, helper: Some(helper) };
		while !shared.slot.lock().opening {
			thread::yield_now();
		}
		fs::rename(&path, path.with_extension("old")).unwrap();
		make_fifo(&path);
		let (passed_tx, passed) = std::sync::mpsc::channel();
		hooks::before_open(&path, move || {
			let _ = passed_tx.send(());
		});
		hooks::when_joining(&path, move || {
			let _ = passed.recv_timeout(LIMIT);
		});
		let start = std::time::Instant::now();
		let dropper = thread::spawn(move || drop(opened));
		while !dropper.is_finished() && start.elapsed() < LIMIT {
			thread::sleep(Duration::from_millis(5));
		}
		let returned = dropper.is_finished();
		let start = std::time::Instant::now();
		while Arc::strong_count(&shared) != 1 && start.elapsed() < LIMIT {
			thread::sleep(Duration::from_millis(5));
		}
		let in_open = shared.slot.lock().in_open;
		// A reader of the new FIFO ends a helper that opened it, so the test
		// ends.
		let _reader = fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&path)
			.unwrap();
		dropper.join().unwrap();
		while Arc::strong_count(&shared) != 1 {
			thread::yield_now();
		}
		assert!(returned, "the drop had not returned after {LIMIT:?}");
		assert!(shared.slot.lock().left, "the drop did not leave the helper");
		assert!(!in_open, "the drop let the helper go on before it left it: it opened the new FIFO");
	}

	/// A drop that waits for a helper that opens the name stops once the
	/// name names another file, well before its bound ([`LEAVE_AFTER`]): the
	/// helper here waits on another FIFO B, whose name the pinned FIFO took
	/// back before the drop (as in the test below), and the hook run when the
	/// drop starts to wait moves the pinned FIFO's name away. A drop that
	/// went on waiting would wait out its bound, as B has no reader. The
	/// pinned FIFO takes its name back only once the helper is seen waiting in
	/// `open(2)` of B ([`wait_in_open`]): a helper still on its way there
	/// would open the pinned FIFO, which the drop's end completes, and the test
	/// would pass whatever the drop's wait does. Linux only, as only `/proc`
	/// shows that; without `/proc/self/task` it checks nothing and says so.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_drop_stops_waiting_for_a_helper_once_the_name_moves_away() {
		const LIMIT: Duration = Duration::from_secs(10);
		if !Path::new("/proc/self/task").is_dir() {
			eprintln!("UNKNOWN: no /proc/self/task shows the helper in open(2); nothing was checked");
			return;
		}
		let (_dir, path) = new_fifo();
		let (aside, other, gone) =
			(path.with_extension("a"), path.with_extension("b"), path.with_extension("c"));
		let (swapped_tx, swapped) = std::sync::mpsc::channel();
		let at = path.clone();
		hooks::before_open(&path, move || {
			fs::rename(&at, at.with_extension("a")).unwrap();
			make_fifo(&at);
			let _ = swapped_tx.send(crate::tests::thread_id());
		});
		let node = Arc::new(Node::new(&path, &fs::metadata(&path).unwrap(), false, true));
		let shared = Arc::new(Shared { slot: Mutex::new(Slot::default()), done: Condvar::new() });
		let helper = spawn_helper(Arc::clone(&shared), Arc::clone(&node), write_end).unwrap();
		let opened = FifoOpen { shared: Arc::clone(&shared), node, helper: Some(helper) };
		let tid = swapped
			.recv_timeout(LIMIT)
			.expect("the helper never reached its open");
		wait_in_open(tid, LIMIT);
		assert!(!shared.slot.lock().exited, "the helper did not wait on B");
		fs::rename(&path, &other).unwrap();
		fs::rename(&aside, &path).unwrap();
		let (at, to) = (path.clone(), gone.clone());
		hooks::when_joining(&path, move || fs::rename(&at, &to).unwrap());
		let start = std::time::Instant::now();
		let dropper = thread::spawn(move || drop(opened));
		while !dropper.is_finished() && start.elapsed() < LIMIT {
			thread::sleep(Duration::from_millis(5));
		}
		let took = dropper.is_finished().then(|| start.elapsed());
		// Either way, a reader of B ends the helper's open.
		let _reader = fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&other)
			.unwrap();
		dropper.join().unwrap();
		while Arc::strong_count(&shared) != 1 {
			thread::yield_now();
		}
		assert!(fs::metadata(&gone).is_ok(), "the drop did not wait for the helper");
		let took = took.unwrap_or_else(|| panic!("the drop had not returned after {LIMIT:?}"));
		assert!(
			took < LEAVE_AFTER / 2,
			"the drop took {took:?}: it waited for its bound after the name moved away"
		);
	}

	/// What the route test's helper returns: the path it was handed, which is
	/// no file to truncate.
	impl TruncateRegular for (PathBuf, bool) {
		fn truncate_regular(&self) -> io::Result<()> {
			Ok(())
		}
	}

	/// An open that creates (`O_CREAT`) is handed the path it was given, so
	/// the kernel checks `O_CREAT` against the path's directory, as for a
	/// plain `open(2)` of the path (`fs.protected_fifos`). An open that does
	/// not create is handed the pin's `/proc/self/fd/N` where procfs reaches
	/// the pin (Linux), else the path.
	#[test]
	fn an_open_that_creates_is_handed_its_path_and_one_that_does_not_the_pin() {
		let (_dir, path) = new_fifo();
		let proc = cfg!(target_os = "linux") && Path::new("/proc/self/fd").is_dir();
		let handed = |creates| {
			let meta = fs::metadata(&path).unwrap();
			let mut opened =
				FifoOpen::start(&path, &meta, false, creates, false, |given: &Path, pinned| {
					Ok((given.to_path_buf(), pinned))
				});
			let reopens = opened.node.reopens;
			loop {
				if let Some(result) = opened.wait_for(Duration::from_secs(1)) {
					break (result.unwrap(), reopens);
				}
			}
		};
		let (given, reopens) = handed(true);
		assert_eq!(given, (path.clone(), false), "an open that creates");
		assert!(!reopens, "an open that creates was routed through the pin");
		let ((given, pinned), reopens) = handed(false);
		if proc {
			assert!(
				pinned && given.starts_with("/proc/self/fd"),
				"an open that does not create was handed {given:?}, pinned {pinned}"
			);
		} else {
			assert_eq!((given, pinned), (path.clone(), false), "an open that does not create");
		}
		assert_eq!(reopens, proc, "an open that does not create: its route");
	}

	/// A drop waits for a helper that opens its path (an open that creates)
	/// only while the path names the FIFO the open started on. Here the path
	/// names a new FIFO before the helper opens it: the drop's end, of the
	/// FIFO the open started on, cannot complete the helper's open of the
	/// new one, so the drop leaves the helper and returns (a drop that waits
	/// for the helper fails the test within its bound). The helper,
	/// held until the drop has left it, reaches its last check after that and
	/// opens nothing: it ends with no reader of the new FIFO, which a helper
	/// that opened it would wait for. The old FIFO is moved aside, not
	/// removed, so the new one cannot reuse its inode number and pass for it.
	#[test]
	fn a_drop_leaves_a_helper_whose_path_names_another_fifo_before_it_opens() {
		const LIMIT: Duration = Duration::from_secs(10);
		let (_dir, path) = new_fifo();
		let node = Arc::new(Node::new(&path, &fs::metadata(&path).unwrap(), false, true));
		let slot = Slot { hold: true, ..Slot::default() };
		let shared = Arc::new(Shared { slot: Mutex::new(slot), done: Condvar::new() });
		let helper = spawn_helper(Arc::clone(&shared), Arc::clone(&node), write_end).unwrap();
		let opened =
			FifoOpen { shared: Arc::clone(&shared), node: Arc::clone(&node), helper: Some(helper) };
		while !shared.slot.lock().opening {
			thread::yield_now();
		}
		fs::rename(&path, path.with_extension("old")).unwrap();
		make_fifo(&path);
		let start = std::time::Instant::now();
		let dropper = thread::spawn(move || drop(opened));
		while !dropper.is_finished() && start.elapsed() < LIMIT {
			thread::sleep(Duration::from_millis(5));
		}
		let returned = dropper.is_finished();
		// A drop still waiting for the helper is released by a reader of the
		// new FIFO, which the helper's open waits for, so the test ends.
		let reader = (!returned).then(|| {
			fs::OpenOptions::new()
				.read(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&path)
				.unwrap()
		});
		dropper.join().unwrap();
		drop(reader);
		assert!(
			returned,
			"the drop had not returned after {LIMIT:?}: it waited for a helper whose path names \
			 another FIFO"
		);
		assert!(shared.slot.lock().left, "the drop did not leave the helper");
		let start = std::time::Instant::now();
		while Arc::strong_count(&shared) != 1 && start.elapsed() < LIMIT {
			thread::sleep(Duration::from_millis(5));
		}
		let ended = Arc::strong_count(&shared) == 1;
		let (in_open, writer) = (shared.slot.lock().in_open, has_writer(&path));
		if !ended {
			// Release a helper that opened the new FIFO, so the test ends.
			let _reader = fs::OpenOptions::new()
				.read(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&path)
				.unwrap();
			while Arc::strong_count(&shared) != 1 {
				thread::yield_now();
			}
		}
		assert!(!node.reopens, "the helper's route was not the path");
		assert!(
			ended,
			"the helper the drop left had not ended after {LIMIT:?}: it opened the new FIFO"
		);
		assert!(!in_open && !writer, "the helper the drop left opened the new FIFO");
	}

	/// A drop's peer opened by name (no `/proc/self/fd/N` reaches the pin)
	/// is checked to be the pinned FIFO after its open, not only before:
	/// here the name is given to another FIFO between the check that the
	/// name names the pinned FIFO and the open, so the open reaches the
	/// other FIFO. That peer is closed and not used: no peer is given, and no
	/// end of the other FIFO stays open. The pinned FIFO is moved aside, not
	/// removed, so the other one cannot reuse its inode number and pass for
	/// it.
	#[test]
	fn a_peer_whose_name_names_another_fifo_by_its_open_is_closed() {
		let (_dir, path) = new_fifo();
		let node =
			Node { reopen: None, ..Node::new(&path, &fs::metadata(&path).unwrap(), false, true) };
		let swapped = path.clone();
		hooks::before_peer_open(&path, move || {
			fs::rename(&swapped, swapped.with_extension("old")).unwrap();
			make_fifo(&swapped);
		});
		let peer = node.peer();
		let held = (has_reader(&path), has_writer(&path));
		let kept = peer.is_some();
		drop(peer);
		assert!(fs::metadata(path.with_extension("old")).is_ok(), "the name was not swapped");
		assert!(!kept, "a peer of another FIFO was given");
		assert_eq!(held, (false, false), "an end of the other FIFO stayed open");
	}

	/// Waits until the helper thread `tid` is seen waiting in `open(2)`
	/// ([`crate::tests::waits_in_open`]), for at most `limit`: the event a
	/// test needs before it changes what the name names under a helper past
	/// its last check, as a helper still on its way would open what the name
	/// names after the change. Where `/proc/self/task/<tid>/syscall` is not
	/// there (gVisor), a sleeping thread counts: the helpers here have nothing
	/// to sleep on between the hook that hands over `tid` and their open.
	#[cfg(target_os = "linux")]
	fn wait_in_open(tid: libc::c_long, limit: Duration) {
		let start = std::time::Instant::now();
		while crate::tests::waits_in_open(tid) != Some(true) {
			assert!(start.elapsed() < limit, "the helper was not seen in open(2) after {limit:?}");
			thread::sleep(Duration::from_millis(1));
		}
	}

	/// The name the probe of the test below swaps: a pin's probe is given
	/// the pin's `/proc/self/fd/N`, not the name.
	#[cfg(target_os = "linux")]
	static SWAPPED: Mutex<Option<PathBuf>> = Mutex::new(None);

	/// The probe of the test below, run by the helper just before its open:
	/// the pinned FIFO is moved to `<name>.a`, and a new FIFO takes the name,
	/// so the helper's open of the name waits on the new one.
	#[cfg(target_os = "linux")]
	fn swap_in_another_fifo(_: &Path) -> bool {
		let Some(name) = SWAPPED.lock().clone() else {
			return false;
		};
		if fs::rename(&name, name.with_extension("a")).is_err() {
			return false;
		}
		make_fifo(&name);
		true
	}

	/// A drop returns within its bound though its helper waits on another
	/// FIFO and the name names the pinned FIFO again when the drop looks:
	/// the name was given to another FIFO for the helper's open (a write open
	/// that creates, so by the name), then given back. The drop's end cannot
	/// reach the other FIFO, so it leaves the helper there and holds no end of
	/// the pinned FIFO once it returns. A drop that waited for the helper
	/// would wait until the other FIFO's reader opens, holding both ends of
	/// the pinned FIFO. The other FIFO's reader then ends the helper. The name
	/// is given back only once the helper is seen waiting in `open(2)`
	/// ([`wait_in_open`]): a helper still on its way there would open the
	/// pinned FIFO by then, which the drop's end completes, and the test would
	/// pass with no bound. Linux only, as only `/proc` shows that; without
	/// `/proc/self/task` it checks nothing and says so.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_drop_returns_while_its_helper_waits_on_a_fifo_moved_away_from_the_name() {
		const LIMIT: Duration = Duration::from_secs(10);
		if !Path::new("/proc/self/task").is_dir() {
			eprintln!("UNKNOWN: no /proc/self/task shows the helper in open(2); nothing was checked");
			return;
		}
		let (_dir, path) = new_fifo();
		let (aside, other) = (path.with_extension("a"), path.with_extension("b"));
		*SWAPPED.lock() = Some(path.clone());
		let (tid_tx, tid) = std::sync::mpsc::channel();
		hooks::before_open(&path, move || {
			let _ = tid_tx.send(crate::tests::thread_id());
		});
		let node = Arc::new(Node::new(&path, &fs::metadata(&path).unwrap(), false, true));
		let slot = Slot { probe: Some(swap_in_another_fifo), ..Slot::default() };
		let shared = Arc::new(Shared { slot: Mutex::new(slot), done: Condvar::new() });
		let helper = spawn_helper(Arc::clone(&shared), Arc::clone(&node), write_end).unwrap();
		let opened = FifoOpen { shared: Arc::clone(&shared), node, helper: Some(helper) };
		let tid = tid.recv_timeout(LIMIT);
		let peer_held = shared.slot.lock().peer_held;
		assert_eq!(peer_held, Some(true), "the helper's probe could not swap the name");
		wait_in_open(tid.expect("the helper never reached its open"), LIMIT);
		assert!(!shared.slot.lock().exited, "the helper did not wait on the other FIFO");
		fs::rename(&path, &other).unwrap();
		fs::rename(&aside, &path).unwrap();
		let start = std::time::Instant::now();
		let dropper = thread::spawn(move || drop(opened));
		while !dropper.is_finished() && start.elapsed() < LIMIT {
			thread::sleep(Duration::from_millis(5));
		}
		let returned = dropper.is_finished().then(|| start.elapsed());
		let held = (has_reader(&path), has_writer(&path));
		// Either way, a reader of the other FIFO ends the helper's open.
		let _reader = fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&other)
			.unwrap();
		dropper.join().unwrap();
		while Arc::strong_count(&shared) != 1 {
			thread::yield_now();
		}
		assert!(returned.is_some(), "the drop had not returned after {LIMIT:?}");
		assert_eq!(held, (false, false), "the drop left an end of the pinned FIFO open");
	}
}
