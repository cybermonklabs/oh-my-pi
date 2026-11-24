//! One end of a FIFO opened on a helper thread ([`FifoOpen`]).

use std::{
	fs, io,
	os::{
		fd::OwnedFd,
		unix::fs::{MetadataExt, OpenOptionsExt},
	},
	panic::{AssertUnwindSafe, catch_unwind},
	path::{Path, PathBuf},
	sync::Arc,
	task::{Context, Poll, Waker},
	thread,
	time::Duration,
};

use parking_lot::{Condvar, Mutex};

/// One end of a FIFO being opened on a helper thread.
///
/// A read-only or write-only open of a FIFO waits in `open(2)` until the
/// other end opens. The helper runs the caller's open, so it returns exactly
/// when a blocking open would, while the caller waits for it as a pending
/// operation ([`FifoOpen::poll`], [`FifoOpen::wait_for`]) and gives it up by
/// dropping it.
///
/// Dropping an open whose result was not taken leaves no end of the FIFO
/// behind once the drop returns. A helper that has not passed its check of
/// the cancel opens nothing, and a result it stored that was not taken is
/// closed. A helper that passed its check is in `open(2)`, or about to enter
/// it: the drop holds the FIFO open for reading and writing, which never
/// waits on a FIFO and completes that open whether it waits already or not
/// yet, until it has joined the helper, which closes what it got. The
/// FIFO's real other end can observe that brief peer, as it can every
/// release: a writer that comes and goes reads as end of file, a reader that
/// comes and goes makes a writer's first write fail with `EPIPE`. Other
/// opens of the same end waiting at that moment are released with it.
///
/// On Linux the open pins the FIFO with an `O_PATH` descriptor, which opens
/// no end of it, and the helper and the drop both open its
/// `/proc/self/fd/N`, so both reach the FIFO the open started on whatever its
/// path names later.
///
/// What is left: a FIFO this process may not open for both reading and
/// writing keeps its helper until its other end opens; the helper then takes
/// that connection and closes it. Without procfs the FIFO is reached by its
/// path: a path that no longer names it leaves the helper waiting too, and a
/// path that another process points at a new FIFO after the drop opened its
/// end but before the helper's `open(2)` makes the join wait until that new
/// FIFO's other end opens.
///
/// A read-only open started with [`FifoOpen::start_reading`] under gVisor
/// ([`on_gvisor`]) does not depend on its `open(2)` being woken. gVisor
/// before google/gvisor@d6786915 can leave a reader in `open(2)` after a
/// writer opened, wrote and closed. While the helper is still in `open(2)`
/// after [`FIRST_PROBE`] (then twice as long each time, up to
/// [`LAST_PROBE`]), the open looks at the FIFO through a read end that does
/// not wait: bytes in it mean a writer came, so that end, made blocking, is
/// the open's result, and write opens that do not wait (the sleeping helper
/// is a reader, so they succeed) wake the helper, whose end is closed.
///
/// Elsewhere nothing looks: on Linux a blocking reader waits for a writer
/// even when bytes another reader left wait in the FIFO, and a look would
/// take them. Under gVisor that is the look's first limit: a read-only open
/// of a FIFO that holds bytes another reader left, with no writer, ends after
/// the first look with those bytes, where Linux waits for a writer. Its
/// second: a writer that closes without writing leaves no bytes to see, and
/// the helper waits as before.
pub struct FifoOpen<T> {
	shared:  Arc<Shared<T>>,
	node:    Arc<Node>,
	helper:  Option<thread::JoinHandle<()>>,
	/// The thread that looks for a writer the helper missed
	/// ([`FifoOpen::start_reading`]).
	watcher: Option<thread::JoinHandle<()>>,
}

/// How long a read-only open waits in `open(2)` before it first looks for a
/// writer the helper missed ([`FifoOpen::start_reading`]).
pub const FIRST_PROBE: Duration = Duration::from_millis(50);

/// The longest wait between two looks.
pub const LAST_PROBE: Duration = Duration::from_secs(1);

/// How a read end found by the look becomes the open's result.
type Adopt<T> = Box<dyn FnOnce(fs::File) -> io::Result<T> + Send>;

/// What an open and its helper share.
struct Shared<T> {
	slot: Mutex<Slot<T>>,
	/// Notified once the helper has stored its result.
	done: Condvar,
}

/// Helpers a drop left in `open(2)` that have not returned
/// ([`FifoOpen::release`]): on gVisor each is a thread asleep until a writer
/// of its FIFO comes, if one ever does.
static LEFT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// The most helpers left at once: past it a read-only open is not looked at
/// ([`FifoOpen::start_reading`] falls back to [`FifoOpen::start`]), so no
/// more are left. Each holds a 64 KiB stack and no descriptor.
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
		let release = unsafe { std::ffi::CStr::from_ptr(name.release.as_ptr()) };
		gvisor_release(release.to_bytes())
	});
	*ON_GVISOR
}

/// Whether a kernel release uname(2) gives is gVisor's: it ends in
/// `-gvisor`, as a distribution's kernel ends in `-generic` or `-azure`.
fn gvisor_release(release: &[u8]) -> bool {
	release.ends_with(b"-gvisor")
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
	/// The helper's `open(2)` returned (or it never entered it).
	returned:  bool,
	/// The drop left this helper in `open(2)` ([`FifoOpen::release`]): it
	/// counts in [`LEFT`] until it returns.
	left:      bool,
	/// The open's result is the read end the look found, not the helper's.
	rescued:   bool,
	/// Test hook: the read ends the look opened.
	#[cfg(test)]
	looks:     usize,
	/// Test hook: after its check, the helper waits until the drop is about
	/// to join it.
	#[cfg(test)]
	hold:      bool,
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
	/// Test hook: a reader gVisor leaves asleep. The helper opens a read end
	/// that does not wait (a reader of the FIFO, as one in `open(2)` is) and
	/// does not return until the open has a result or is cancelled.
	#[cfg(test)]
	stuck:     bool,
	/// Test hook: a `stuck` helper stays asleep, cancelled or not, until this
	/// is cleared (one gVisor does not wake even for the drop's end).
	#[cfg(test)]
	stay:      bool,
	/// Test hook: the watcher's first wait, in place of [`FIRST_PROBE`].
	#[cfg(test)]
	first:     Option<Duration>,
}

impl<T> Default for Slot<T> {
	fn default() -> Self {
		Self {
			result:                 None,
			waker:                  None,
			finished:               false,
			cancelled:              false,
			opening:                false,
			returned:               false,
			left:                   false,
			rescued:                false,
			#[cfg(test)]
			looks:                  0,
			#[cfg(test)]
			hold:                   false,
			#[cfg(test)]
			joining:                false,
			#[cfg(test)]
			probe:                  None,
			#[cfg(test)]
			peer_held:              None,
			#[cfg(test)]
			stuck:                  false,
			#[cfg(test)]
			stay:                   false,
			#[cfg(test)]
			first:                  None,
		}
	}
}

/// The FIFO an open started on, which its helper opens and its drop
/// releases.
struct Node {
	/// What both open. On Linux it is `/proc/self/fd/N` of an `O_PATH`
	/// descriptor of the FIFO (which opens no end of it), so both reach this
	/// node whatever the original path names later. Elsewhere, or without
	/// procfs, it is the path itself.
	path: PathBuf,
	/// Device and inode.
	id:   (u64, u64),
	/// The pin, an `O_PATH` descriptor of the FIFO (Linux only).
	pin:  Option<OwnedFd>,
}

impl Node {
	/// The node at `path`, which `meta` describes. With `nofollow` a symbolic
	/// link at `path` is not pinned, so the helper's own open of the path
	/// refuses it.
	fn new(path: &Path, meta: &fs::Metadata, nofollow: bool) -> Self {
		#[cfg(target_os = "linux")]
		if let Some(node) = Self::pinned_at(path, nofollow) {
			return node;
		}
		#[cfg(not(target_os = "linux"))]
		let _ = nofollow;
		Self { path: path.to_path_buf(), id: (meta.dev(), meta.ino()), pin: None }
	}

	/// The FIFO at `path`, pinned with an `O_PATH` descriptor, when procfs
	/// reaches it through `/proc/self/fd/N`.
	#[cfg(target_os = "linux")]
	fn pinned_at(path: &Path, nofollow: bool) -> Option<Self> {
		use std::os::{
			fd::FromRawFd,
			unix::{ffi::OsStrExt, fs::FileTypeExt},
		};
		let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
		let flags = libc::O_PATH | libc::O_CLOEXEC | if nofollow { libc::O_NOFOLLOW } else { 0 };
		// SAFETY: `c_path` is a NUL-terminated string that outlives the call.
		let fd = unsafe { libc::open(c_path.as_ptr(), flags) };
		if fd < 0 {
			return None;
		}
		// SAFETY: `fd` was just opened, and nothing else owns it.
		let pin = fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
		let meta = pin.metadata().ok().filter(|m| m.file_type().is_fifo())?;
		let node = Self {
			path: PathBuf::from(format!("/proc/self/fd/{fd}")),
			id:   (meta.dev(), meta.ino()),
			pin:  Some(OwnedFd::from(pin)),
		};
		node.is(fs::metadata(&node.path)).then_some(node)
	}

	/// Whether the helper and the drop reach this node through a pin.
	const fn pinned(&self) -> bool {
		self.pin.is_some()
	}

	/// Whether `meta` describes this node.
	fn is(&self, meta: io::Result<fs::Metadata>) -> bool {
		meta.is_ok_and(|m| (m.dev(), m.ino()) == self.id)
	}
}

impl<T: Send + 'static> FifoOpen<T> {
	/// Starts opening the FIFO at `path`, which `meta` describes, on a helper
	/// thread, which calls `open` with the path to open and whether that path
	/// is a pin's `/proc/self/fd/N`. That path is a symbolic link, which the
	/// open must follow, so with it the open drops `O_NOFOLLOW`; with
	/// `nofollow` a symbolic link at `path` is never pinned, so `open`'s own
	/// `O_NOFOLLOW` open of the path refuses it. When the helper cannot be
	/// started, its error is the open's result.
	pub fn start<F>(path: &Path, meta: &fs::Metadata, nofollow: bool, open: F) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
	{
		Self::begin(path, meta, nofollow, open, None)
	}

	/// [`FifoOpen::start`] for a read-only open that, under gVisor
	/// ([`on_gvisor`]), does not depend on its `open(2)` being woken (see
	/// [`FifoOpen`]): a read end the look finds is made the open's result by
	/// `adopt`. Elsewhere it is [`FifoOpen::start`].
	pub fn start_reading<F, A>(
		path: &Path,
		meta: &fs::Metadata,
		nofollow: bool,
		open: F,
		adopt: A,
	) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
		A: FnOnce(fs::File) -> io::Result<T> + Send + 'static,
	{
		Self::start_reading_on(path, meta, nofollow, open, adopt, on_gvisor())
	}

	/// [`FifoOpen::start_reading`] as on gVisor (`gvisor`) or elsewhere.
	fn start_reading_on<F, A>(
		path: &Path,
		meta: &fs::Metadata,
		nofollow: bool,
		open: F,
		adopt: A,
		gvisor: bool,
	) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
		A: FnOnce(fs::File) -> io::Result<T> + Send + 'static,
	{
		let adopt = gvisor.then(|| Box::new(adopt) as Adopt<T>);
		Self::begin(path, meta, nofollow, open, adopt)
	}

	fn begin<F>(
		path: &Path,
		meta: &fs::Metadata,
		nofollow: bool,
		open: F,
		adopt: Option<Adopt<T>>,
	) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
	{
		let node = Arc::new(Node::new(path, meta, nofollow));
		let shared = Arc::new(Shared { slot: Mutex::new(Slot::default()), done: Condvar::new() });
		let helper = match spawn_helper(Arc::clone(&shared), Arc::clone(&node), open) {
			Ok(helper) => Some(helper),
			Err(e) => {
				shared.slot.lock().result = Some(Err(e));
				None
			},
		};
		// Without a watcher the open waits on its helper alone, as before:
		// also once `MAX_LEFT` helpers are left.
		let watcher = adopt
			.filter(|_| helper.is_some() && may_look(LEFT.load(std::sync::atomic::Ordering::Relaxed)))
			.and_then(|adopt| spawn_watcher(Arc::clone(&shared), Arc::clone(&node), adopt).ok());
		Self { shared, node, helper, watcher }
	}
}

/// Starts the thread that looks for a writer the helper of a read-only open
/// missed ([`FifoOpen::start_reading`]): while the helper is in `open(2)`,
/// after [`FIRST_PROBE`], then twice as long each time up to [`LAST_PROBE`],
/// it opens a read end that does not wait and asks how many bytes wait in
/// the FIFO. None: it changes nothing. Some: a writer came, so that end, made
/// blocking, becomes the open's result through `adopt`, and the helper is
/// woken ([`wake_helper`]). It ends with the open's result or its drop.
fn spawn_watcher<T: Send + 'static>(
	shared: Arc<Shared<T>>,
	node: Arc<Node>,
	adopt: Adopt<T>,
) -> io::Result<thread::JoinHandle<()>> {
	thread::Builder::new()
		.name("fifo-watch".to_owned())
		.stack_size(64 << 10)
		.spawn(move || {
			// The open is over: it has a result, or the helper returned.
			let over = |s: &Slot<T>| s.result.is_some() || s.finished || s.cancelled || s.returned;
			#[cfg(not(test))]
			let mut wait = FIRST_PROBE;
			#[cfg(test)]
			let mut wait = shared.slot.lock().first.unwrap_or(FIRST_PROBE);
			let end = loop {
				{
					let mut s = shared.slot.lock();
					if !over(&s) {
						shared.done.wait_for(&mut s, wait);
					}
					if over(&s) {
						return;
					}
					if !s.opening {
						continue;
					}
					#[cfg(test)]
					{
						s.looks += 1;
					}
				}
				wait = (wait * 2).min(LAST_PROBE);
				if let Some(end) = waiting_bytes(&node) {
					break end;
				}
			};
			let Ok(result) = adopt(end) else {
				return;
			};
			let mut s = shared.slot.lock();
			if over(&s) {
				return;
			}
			s.result = Some(Ok(result));
			s.rescued = true;
			let waker = s.waker.take();
			drop(s);
			shared.done.notify_all();
			if let Some(w) = waker {
				w.wake();
			}
			wake_helper(&shared, &node);
		})
}

/// A read end of `node` that does not wait, when bytes wait in the FIFO:
/// then made blocking, as the helper's open would leave it.
fn waiting_bytes(node: &Node) -> Option<fs::File> {
	use std::os::fd::AsRawFd;
	let end = fs::OpenOptions::new()
		.read(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(&node.path)
		.ok()?;
	if !node.is(end.metadata()) {
		return None;
	}
	let fd = end.as_raw_fd();
	let mut waiting: libc::c_int = 0;
	// SAFETY: FIONREAD writes one int through the pointer, which outlives the
	// call; `fd` is our open descriptor.
	if unsafe { libc::ioctl(fd, libc::FIONREAD as _, &raw mut waiting) } < 0 || waiting <= 0 {
		return None;
	}
	// SAFETY: F_GETFL reads the status flags of our own open descriptor.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 {
		return None;
	}
	// SAFETY: F_SETFL sets the status flags of our own open descriptor.
	if unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
		return None;
	}
	Some(end)
}

/// Wakes a helper still in `open(2)` once the look took the open: a write
/// end that does not wait, opened and closed (the helper is a reader, so the
/// open succeeds), until the helper's `open(2)` has returned, at most 100
/// times 10 ms apart. A helper gVisor leaves asleep each time stays until a
/// writer comes, then closes what it gets.
fn wake_helper<T>(shared: &Shared<T>, node: &Node) {
	for _ in 0..100 {
		if let Ok(end) = fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&node.path)
		{
			drop(end);
		}
		let mut s = shared.slot.lock();
		if s.returned || s.cancelled {
			return;
		}
		shared.done.wait_for(&mut s, Duration::from_millis(10));
		if s.returned || s.cancelled {
			return;
		}
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
	pub fn wait_for(&mut self, timeout: Duration) -> Option<io::Result<T>> {
		let mut s = self.shared.slot.lock();
		if s.result.is_none() {
			self.shared.done.wait_for(&mut s, timeout);
		}
		let result = s.result.take();
		s.finished |= result.is_some();
		result
	}
}

/// The helper is out of `open(2)`: a helper the drop left stops counting in
/// [`LEFT`].
fn helper_returned<T>(s: &mut Slot<T>) {
	s.returned = true;
	if s.left {
		s.left = false;
		LEFT.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
	}
}

/// Starts the thread that opens `node` with `open`, unless the open is
/// cancelled before it gets there.
fn spawn_helper<T, F>(
	shared: Arc<Shared<T>>,
	node: Arc<Node>,
	open: F,
) -> io::Result<thread::JoinHandle<()>>
where
	T: Send + 'static,
	F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
{
	thread::Builder::new()
		.name("fifo-open".to_owned())
		.stack_size(64 << 10)
		.spawn(move || {
			{
				let mut s = shared.slot.lock();
				if s.cancelled {
					return;
				}
				s.opening = true;
			}
			#[cfg(test)]
			{
				let held = || {
					let s = shared.slot.lock();
					s.hold && !s.joining
				};
				while held() {
					thread::yield_now();
				}
				let probe = shared.slot.lock().probe;
				if let Some(probe) = probe {
					let peer_held = probe(&node.path);
					shared.slot.lock().peer_held = Some(peer_held);
					if !peer_held {
						return;
					}
				}
				if shared.slot.lock().stuck {
					// A reader that `open(2)` left asleep: registered, never
					// woken by the writer.
					let held = fs::OpenOptions::new()
						.read(true)
						.custom_flags(libc::O_NONBLOCK)
						.open(&node.path);
					let mut s = shared.slot.lock();
					while (s.result.is_none() && !s.finished && !s.cancelled) || s.stay {
						shared.done.wait_for(&mut s, Duration::from_millis(10));
					}
					let cancelled = s.cancelled;
					drop(s);
					drop(held);
					if cancelled {
						helper_returned(&mut shared.slot.lock());
						return;
					}
				}
			}
			let opened = catch_unwind(AssertUnwindSafe(|| open(&node.path, node.pinned())))
				.unwrap_or_else(|_| Err(io::Error::other("the FIFO open panicked")));
			let mut s = shared.slot.lock();
			helper_returned(&mut s);
			// Cancelled, or the look found the writer first: what the
			// helper got is closed.
			let taken = s.cancelled || s.result.is_some() || s.finished;
			if !taken {
				s.result = Some(opened);
			}
			let waker = if taken { None } else { s.waker.take() };
			drop(s);
			shared.done.notify_all();
			if let Some(w) = waker {
				w.wake();
			}
		})
}

impl<T> Drop for FifoOpen<T> {
	/// See [`FifoOpen`]: leaves no end of the FIFO behind once it returns.
	fn drop(&mut self) {
		self.release();
		if let Some(watcher) = self.watcher.take() {
			self.shared.done.notify_all();
			let _ = watcher.join();
		}
	}
}

/// How long a drop waits for a helper the look took the open from to return
/// from its `open(2)` once the drop's own end is open: gVisor left it asleep
/// through its writer and the look's wake-ups, and may leave it asleep
/// through this one too ([`FifoOpen::release`]).
const RESCUED_JOIN: Duration = Duration::from_millis(100);

impl<T> FifoOpen<T> {
	/// The drop's release of the helper ([`FifoOpen`]). A helper the look took
	/// the open from is joined only when it returns within [`RESCUED_JOIN`];
	/// else it is left: it holds no end of the FIFO until its `open(2)`
	/// returns, and then closes that end (the open is cancelled). On Linux a
	/// look never takes an open, so every helper is joined.
	fn release(&mut self) {
		let rescued = {
			let mut s = self.shared.slot.lock();
			if s.finished && s.returned {
				return;
			}
			s.cancelled = true;
			let unclaimed = s.result.take();
			// A helper still in `open(2)` is released even when the look gave
			// the open its result.
			if (unclaimed.is_some() && !s.rescued) || !s.opening || s.returned {
				return;
			}
			s.rescued
		};
		let node = &self.node;
		if !node.is(fs::metadata(&node.path)) {
			return;
		}
		let Ok(peer) = fs::OpenOptions::new()
			.read(true)
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&node.path)
		else {
			return;
		};
		if node.is(peer.metadata())
			&& let Some(helper) = self.helper.take()
		{
			#[cfg(test)]
			{
				self.shared.slot.lock().joining = true;
			}
			if rescued {
				let deadline = std::time::Instant::now() + RESCUED_JOIN;
				let mut s = self.shared.slot.lock();
				while !s.returned && !self.shared.done.wait_until(&mut s, deadline).timed_out() {}
				if !s.returned {
					s.left = true;
					LEFT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
					return;
				}
			}
			let _ = helper.join();
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
	/// not wait fails with ENXIO when it has none.
	fn has_reader(path: &Path) -> bool {
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
	fn has_writer(path: &Path) -> bool {
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

	/// An open of `path` whose helper has passed its check of the cancel.
	fn opening(path: &Path, open: Open) -> FifoOpen<fs::File> {
		let opened = FifoOpen::start(path, &fs::metadata(path).unwrap(), false, open);
		while !opened.shared.slot.lock().opening {
			thread::yield_now();
		}
		opened
	}

	fn helper(path: &Path, slot: Slot<fs::File>, open: Open) -> FifoOpen<fs::File> {
		let node = Arc::new(Node::new(path, &fs::metadata(path).unwrap(), false));
		let shared = Arc::new(Shared { slot: Mutex::new(slot), done: Condvar::new() });
		let helper = spawn_helper(Arc::clone(&shared), Arc::clone(&node), open).unwrap();
		FifoOpen { shared, node, helper: Some(helper), watcher: None }
	}

	/// A read-only open of `path` that looks for a writer its helper missed
	/// ([`FifoOpen::start_reading`]), its slot starting as `slot`.
	fn reading(path: &Path, slot: Slot<fs::File>) -> FifoOpen<fs::File> {
		let mut opened = helper(path, slot, read_end);
		let adopt: Adopt<fs::File> = Box::new(Ok);
		opened.watcher =
			Some(spawn_watcher(Arc::clone(&opened.shared), Arc::clone(&opened.node), adopt).unwrap());
		opened
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
		assert_eq!(Arc::strong_count(&shared), 1, "the helper or the watcher outlived the drop");
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
			let opened = FifoOpen::start_reading_on(&path, &meta, false, read_end, Ok, gvisor);
			assert_eq!(opened.watcher.is_some(), gvisor, "on gVisor {gvisor}: the look");
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
		let mut opened = FifoOpen::start_reading_on(&path, &meta, false, read_end, Ok, false);
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
		let mut opened = FifoOpen::start_reading_on(&path, &meta, false, read_end, Ok, true);
		let end = opened
			.wait_for(Duration::from_secs(10))
			.expect("no look took the open in 10 s")
			.unwrap();
		assert!(opened.shared.slot.lock().rescued, "the result is not the look's");
		drop((opened, other));
		assert_eq!(drain(end).0, b"ab");
	}

	/// An open that ends within the watcher's first wait is not looked at.
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
		let watcher = opened.watcher.take().unwrap();
		watcher.join().unwrap();
		assert_eq!(opened.shared.slot.lock().looks, 0, "the open was looked at");
		drop((writer, reader));
	}

	/// A helper left asleep after its writer wrote (the `stuck` hook, as
	/// gVisor leaves one) does not keep the open from its bytes: a look takes
	/// the open, and the look's write opens wake the helper before the drop
	/// does; the helper closes what it gets.
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
		assert_eq!(Arc::strong_count(&shared), 1, "the helper or the watcher outlived the drop");
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
		let (returned_meanwhile, left) = {
			let s = shared.slot.lock();
			(s.returned, s.left)
		};
		shared.slot.lock().stay = false;
		shared.done.notify_all();
		dropper.join().unwrap();
		assert!(!waited, "the drop waited for a helper that does not wake");
		assert!(!returned_meanwhile, "the helper returned while it was held asleep");
		assert!(left, "the left helper is not counted");
		let deadline = std::time::Instant::now() + Duration::from_secs(10);
		while Arc::strong_count(&shared) > 1 {
			assert!(std::time::Instant::now() < deadline, "the helper did not end once released");
			thread::sleep(Duration::from_millis(10));
		}
		assert!(shared.slot.lock().returned);
		assert!(!shared.slot.lock().left, "the helper that returned still counts as left");
		assert_eq!(drain(reader).0, b"ab");
		assert!(!has_reader(&path), "a reader is left");
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

	/// A helper that finds the open cancelled opens nothing: it ends
	/// (instead of waiting in `open(2)` for a writer) and leaves no reader.
	/// Until it ends, the FIFO is watched for the reader a helper that
	/// entered `open(2)` would be, so such a helper fails the test (and the
	/// watch's own write open lets it return) instead of waiting.
	#[test]
	fn a_helper_cancelled_before_its_check_opens_nothing() {
		let (_dir, path) = new_fifo();
		let mut opened = helper(&path, Slot { cancelled: true, ..Slot::default() }, read_end);
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
	/// the FIFO when it returns.
	#[test]
	fn a_drop_after_the_check_ends_the_helper_before_it_returns() {
		for open in [read_end as Open, write_end] {
			let (_dir, path) = new_fifo();
			let opened = opening(&path, open);
			let shared = Arc::clone(&opened.shared);
			drop(opened);
			assert_eq!(Arc::strong_count(&shared), 1, "the helper outlived the drop");
			assert!(!has_reader(&path), "a reader is left");
			assert!(!has_writer(&path), "a writer is left");
		}
	}

	/// A drop that comes while the helper is between its check and its
	/// `open(2)` holds its end of the FIFO until the helper has opened and
	/// closed. The helper here enters `open(2)` only once the drop is about
	/// to join it, and first looks for the drop's end: a drop that did not
	/// join leaves the helper waiting for it, and one that did not hold its
	/// end while it joined is seen without it.
	#[test]
	fn a_drop_holds_its_end_until_a_helper_about_to_open_has_ended() {
		for (open, probe) in
			[(read_end as Open, has_writer as fn(&Path) -> bool), (write_end, has_reader)]
		{
			let (_dir, path) = new_fifo();
			let opened =
				helper(&path, Slot { hold: true, probe: Some(probe), ..Slot::default() }, open);
			let shared = Arc::clone(&opened.shared);
			while !shared.slot.lock().opening {
				thread::yield_now();
			}
			drop(opened);
			assert_eq!(
				shared.slot.lock().peer_held,
				Some(true),
				"the drop's end was not open when the helper opened"
			);
			assert_eq!(Arc::strong_count(&shared), 1, "the helper outlived the drop");
			assert!(!has_reader(&path), "a reader is left");
			assert!(!has_writer(&path), "a writer is left");
		}
	}

	/// An open the helper finished, which the caller never took, is closed
	/// by the drop, not when the last reference to the slot goes: the test
	/// holds one until it has checked.
	#[test]
	fn a_drop_closes_an_open_the_caller_never_took() {
		let (_dir, path) = new_fifo();
		let opened = opening(&path, read_end);
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
		let mut opened = opening(&path, read_end);
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

	/// On Linux the drop reaches the node the open started on, though its
	/// path now names another FIFO. The old FIFO is moved aside, not
	/// removed, so the new one cannot reuse its inode number and pass for it.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_drop_releases_a_helper_whose_path_now_names_another_fifo() {
		let (_dir, path) = new_fifo();
		let opened = opening(&path, read_end);
		let shared = Arc::clone(&opened.shared);
		fs::rename(&path, path.with_extension("old")).unwrap();
		make_fifo(&path);
		drop(opened);
		assert_eq!(Arc::strong_count(&shared), 1, "the helper outlived the drop");
		assert!(!has_reader(&path));
	}
}
