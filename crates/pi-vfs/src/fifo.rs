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
	time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex};

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
/// behind once the drop returns, but for a helper it cannot reach (below). A
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
/// On Linux the open pins the FIFO with an `O_PATH` descriptor, which opens
/// no end of it, and the drop opens its `/proc/self/fd/N`, so the drop
/// reaches the FIFO the open started on whatever its path names later. So
/// does the helper, unless the open creates (`O_CREAT`): that helper opens
/// the path with the caller's own options, so the kernel checks `O_CREAT`
/// against the path's directory as it does for a plain `open(2)` of the
/// path. That check is `fs.protected_fifos`: it refuses an `O_CREAT` open of
/// another user's FIFO in a world-writable sticky directory. The directory
/// of `/proc/self/fd/N` is no sticky directory, so an `O_CREAT` open of the
/// pin would pass it.
///
/// A helper that opens the path (an open that creates; every open without
/// procfs, where the drop opens the path too while it names the FIFO) may
/// open another FIFO: the path can name another file at the moment of its
/// open, and name the FIFO the open started on again when the drop looks
/// (`mv p p.a; mkfifo p` before the helper's open, `mv p p.b; mv p.a p`
/// after it). The drop's end cannot reach that other FIFO. So the drop
/// waits for such a helper only while the path names the FIFO the open
/// started on, and for at most [`LEAVE_AFTER`]: it checks the path every
/// [`POLL_SLICE`] at most, and leaves the helper once the path names another
/// file or the bound has passed. The helper's open of the FIFO the open
/// started on ends at once, as the drop holds its two ends; one still in
/// `open(2)` at the bound waits on another FIFO. A drop that waited longer
/// would hold the two ends of the FIFO the open started on for as long, and
/// keep the thread that dropped the open. A helper the drop leaves before
/// its last check, just before `open(2)`, opens nothing.
///
/// What is left, each until the other end of the FIFO its helper waits on
/// opens; the helper then takes that connection and closes it:
/// - a helper that waits on another FIFO, as above;
/// - a helper of a FIFO this process may not open for both reading and writing,
///   which the drop cannot reach either;
/// - without procfs, a helper whose path no longer names the FIFO when the drop
///   starts;
/// - a helper held up for longer than [`LEAVE_AFTER`] between its last check
///   and its `open(2)`, which then opens the path after the drop has gone.
pub struct FifoOpen<T> {
	shared: Arc<Shared<T>>,
	node:   Arc<Node>,
	helper: Option<thread::JoinHandle<()>>,
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
	/// Test hook: the helper passed its last check, of `abandoned`, just
	/// before its `open(2)`.
	#[cfg(test)]
	in_open:   bool,
	/// The drop left the helper: a helper that has not passed its last
	/// check opens nothing.
	abandoned: bool,
	/// The helper has ended.
	exited:    bool,
	/// Test hook: after its check, the helper waits until the drop is about
	/// to join it, or has left it.
	#[cfg(test)]
	hold:      bool,
	/// Test hook: the drop holds its end of the FIFO and is about to join the
	/// helper.
	#[cfg(test)]
	joining:   bool,
	/// Test hook: the drop returned without joining the helper.
	#[cfg(test)]
	left:      bool,
	/// Test hook: once released by `joining`, the helper asks this whether
	/// the FIFO's other end is open before it opens its own.
	#[cfg(test)]
	probe:     Option<fn(&Path) -> bool>,
	/// Test hook: what `probe` answered. When it answered no, the helper's
	/// open would wait for ever, so the helper skips it.
	#[cfg(test)]
	peer_held: Option<bool>,
}

impl<T> Default for Slot<T> {
	fn default() -> Self {
		Self {
			result:                 None,
			waker:                  None,
			finished:               false,
			cancelled:              false,
			opening:                false,
			#[cfg(test)]
			in_open:                false,
			abandoned:              false,
			exited:                 false,
			#[cfg(test)]
			hold:                   false,
			#[cfg(test)]
			joining:                false,
			#[cfg(test)]
			left:                   false,
			#[cfg(test)]
			probe:                  None,
			#[cfg(test)]
			peer_held:              None,
		}
	}
}

/// The FIFO an open started on, which its helper opens and its drop
/// releases.
struct Node {
	/// What the drop opens. On Linux it is `/proc/self/fd/N` of an `O_PATH`
	/// descriptor of the FIFO (which opens no end of it), so the drop reaches
	/// this node whatever the original path names later. Elsewhere, or
	/// without procfs, it is the path itself.
	path:    PathBuf,
	/// The path the open was given.
	name:    PathBuf,
	/// Whether a symbolic link at `name` is followed (no `O_NOFOLLOW`).
	follow:  bool,
	/// Device and inode.
	id:      (u64, u64),
	/// The pin, an `O_PATH` descriptor of the FIFO (Linux only).
	pin:     Option<OwnedFd>,
	/// The open creates (`O_CREAT`), so its helper opens `name`.
	creates: bool,
}

impl Node {
	/// The node at `path`, which `meta` describes, for an open that
	/// `creates` or not. With `nofollow` a symbolic link at `path` is not
	/// pinned, so the helper's own open of the path refuses it.
	fn new(path: &Path, meta: &fs::Metadata, nofollow: bool, creates: bool) -> Self {
		#[cfg(target_os = "linux")]
		if let Some(node) = Self::pinned_at(path, nofollow) {
			return Self { creates, ..node };
		}
		Self {
			path: path.to_path_buf(),
			name: path.to_path_buf(),
			follow: !nofollow,
			id: (meta.dev(), meta.ino()),
			pin: None,
			creates,
		}
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
			path:    PathBuf::from(format!("/proc/self/fd/{fd}")),
			name:    path.to_path_buf(),
			follow:  !nofollow,
			id:      (meta.dev(), meta.ino()),
			pin:     Some(OwnedFd::from(pin)),
			creates: false,
		};
		node.is(fs::metadata(&node.path)).then_some(node)
	}

	/// Whether the helper opens the pin's `/proc/self/fd/N`: a pinned FIFO,
	/// for an open that does not create. Otherwise it opens the path.
	const fn reopens(&self) -> bool {
		self.pin.is_some() && !self.creates
	}

	/// What the helper opens, and whether it is the pin's `/proc/self/fd/N`.
	fn helper_path(&self) -> (&Path, bool) {
		if self.reopens() {
			(&self.path, true)
		} else {
			(&self.name, false)
		}
	}

	/// Whether `meta` describes this node.
	fn is(&self, meta: io::Result<fs::Metadata>) -> bool {
		meta.is_ok_and(|m| (m.dev(), m.ino()) == self.id)
	}

	/// Whether the path the open was given still names this node.
	fn named(&self) -> bool {
		self.is(if self.follow {
			fs::metadata(&self.name)
		} else {
			fs::symlink_metadata(&self.name)
		})
	}

	/// Opens this node for reading and writing without blocking: the drop's
	/// peer, which completes the helper's open. `None` when `path` no longer
	/// reaches it, or the open fails or reaches another file.
	fn peer(&self) -> Option<fs::File> {
		if !self.is(fs::metadata(&self.path)) {
			return None;
		}
		let peer = fs::OpenOptions::new()
			.read(true)
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&self.path)
			.ok()?;
		self.is(peer.metadata()).then_some(peer)
	}
}

impl<T: Send + 'static> FifoOpen<T> {
	/// Starts opening the FIFO at `path`, which `meta` describes, on a helper
	/// thread, which calls `open` with the path to open and whether that path
	/// is a pin's `/proc/self/fd/N`. That path is a symbolic link, which the
	/// open must follow, so with it the open drops `O_NOFOLLOW`; with
	/// `nofollow` a symbolic link at `path` is never pinned, so `open`'s own
	/// `O_NOFOLLOW` open of the path refuses it. An open that `creates`
	/// (`O_CREAT`) is handed `path` itself, never the pin (see [`FifoOpen`]).
	/// When the helper cannot be started, its error is the open's result.
	pub fn start<F>(path: &Path, meta: &fs::Metadata, nofollow: bool, creates: bool, open: F) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
	{
		let node = Arc::new(Node::new(path, meta, nofollow, creates));
		let shared = Arc::new(Shared { slot: Mutex::new(Slot::default()), done: Condvar::new() });
		let helper = match spawn_helper(Arc::clone(&shared), Arc::clone(&node), open) {
			Ok(helper) => Some(helper),
			Err(e) => {
				let mut s = shared.slot.lock();
				s.result = Some(Err(e));
				s.exited = true;
				None
			},
		};
		Self { shared, node, helper }
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

/// Marks the helper ended when it returns or unwinds.
struct Exit<T>(Arc<Shared<T>>);

impl<T> Drop for Exit<T> {
	fn drop(&mut self) {
		self.0.slot.lock().exited = true;
		self.0.done.notify_all();
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
			let _exit = Exit(Arc::clone(&shared));
			{
				let mut s = shared.slot.lock();
				if s.cancelled {
					return;
				}
				s.opening = true;
			}
			let (path, pinned) = node.helper_path();
			#[cfg(test)]
			{
				let held = || {
					let s = shared.slot.lock();
					s.hold && !s.joining && !s.left
				};
				while held() {
					thread::yield_now();
				}
				let probe = shared.slot.lock().probe;
				if let Some(probe) = probe {
					let peer_held = probe(path);
					shared.slot.lock().peer_held = Some(peer_held);
					if !peer_held {
						return;
					}
				}
				routes::note(&node.name, pinned);
			}
			{
				// The last check: a helper the drop has left opens nothing.
				let s = shared.slot.lock();
				if s.abandoned {
					return;
				}
				#[cfg(test)]
				{
					let mut s = s;
					s.in_open = true;
				}
			}
			let opened = catch_unwind(AssertUnwindSafe(|| open(path, pinned)))
				.unwrap_or_else(|_| Err(io::Error::other("the FIFO open panicked")));
			let mut s = shared.slot.lock();
			if s.cancelled {
				return;
			}
			s.result = Some(opened);
			let waker = s.waker.take();
			drop(s);
			shared.done.notify_all();
			if let Some(w) = waker {
				w.wake();
			}
		})
}

/// How long a drop waits for a helper that opens the path while the path
/// names the FIFO the open started on (see [`FifoOpen`]). That helper's open
/// of that FIFO ends at once, as the drop holds the FIFO's two ends; one that
/// is still waiting when this has passed waits on another FIFO.
const LEAVE_AFTER: Duration = Duration::from_secs(1);

impl<T> Drop for FifoOpen<T> {
	/// See [`FifoOpen`]: leaves no end of the FIFO behind once it returns,
	/// but for a helper it cannot reach: one whose open waits on another
	/// FIFO, which it leaves there. It waits for a helper that opens the path
	/// for at most [`LEAVE_AFTER`].
	fn drop(&mut self) {
		{
			let mut s = self.shared.slot.lock();
			if s.finished {
				return;
			}
			s.cancelled = true;
			let unclaimed = s.result.take();
			if unclaimed.is_some() || !s.opening {
				return;
			}
		}
		let (Some(peer), Some(helper)) = (self.node.peer(), self.helper.take()) else {
			self.leave();
			return;
		};
		let by_path = !self.node.reopens();
		// A path that names another file now leaves the helper at once.
		if by_path && !self.node.named() {
			self.leave();
			return;
		}
		#[cfg(test)]
		{
			self.shared.slot.lock().joining = true;
		}
		if by_path && !self.wait_by_path() {
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

	/// For a helper that opens the path, while the drop holds the FIFO's two
	/// ends: whether the helper ends while the path names the FIFO the open
	/// started on, within [`LEAVE_AFTER`]. The path is checked every
	/// [`POLL_SLICE`] at most.
	fn wait_by_path(&self) -> bool {
		let deadline = Instant::now() + LEAVE_AFTER;
		let mut s = self.shared.slot.lock();
		loop {
			if s.exited {
				return true;
			}
			drop(s);
			let named = self.node.named();
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

/// Test record of the way each helper opened its FIFO, by the path its open
/// was given: through the pin's `/proc/self/fd/N` (`true`) or by the path.
#[cfg(test)]
pub(crate) mod routes {
	use std::path::{Path, PathBuf};

	use parking_lot::Mutex;

	static ROUTES: Mutex<Vec<(PathBuf, bool)>> = Mutex::new(Vec::new());

	pub(crate) fn note(name: &Path, through_pin: bool) {
		ROUTES.lock().push((name.to_path_buf(), through_pin));
	}

	/// The routes of the helpers whose open was given `name`, in order.
	pub(crate) fn of(name: &Path) -> Vec<bool> {
		ROUTES
			.lock()
			.iter()
			.filter(|(path, _)| path == name)
			.map(|&(_, through_pin)| through_pin)
			.collect()
	}
}

#[cfg(test)]
mod tests {
	use std::{
		io::Read,
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

	/// An open of `path`, which `creates` or not, whose helper has passed its
	/// check of the cancel.
	fn opening(path: &Path, creates: bool, open: Open) -> FifoOpen<fs::File> {
		let opened = FifoOpen::start(path, &fs::metadata(path).unwrap(), false, creates, open);
		while !opened.shared.slot.lock().opening {
			thread::yield_now();
		}
		opened
	}

	fn helper(path: &Path, slot: Slot<fs::File>, creates: bool, open: Open) -> FifoOpen<fs::File> {
		let node = Arc::new(Node::new(path, &fs::metadata(path).unwrap(), false, creates));
		let shared = Arc::new(Shared { slot: Mutex::new(slot), done: Condvar::new() });
		let helper = spawn_helper(Arc::clone(&shared), Arc::clone(&node), open).unwrap();
		FifoOpen { shared, node, helper: Some(helper) }
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
	/// (or on the new one, had it not opened before the rename) until a
	/// writer of it opens, which this test then is. The old FIFO is moved
	/// aside, not removed, so the new one cannot reuse its inode number and
	/// pass for it.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_drop_releases_a_helper_whose_path_now_names_another_fifo() {
		let (_dir, path) = new_fifo();
		let opened = opening(&path, false, read_end);
		let shared = Arc::clone(&opened.shared);
		let old = path.with_extension("old");
		fs::rename(&path, &old).unwrap();
		make_fifo(&path);
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
			let mut opened = FifoOpen::start(&path, &meta, false, creates, |given: &Path, pinned| {
				Ok((given.to_path_buf(), pinned))
			});
			loop {
				if let Some(result) = opened.wait_for(Duration::from_secs(1)) {
					break result.unwrap();
				}
			}
		};
		assert_eq!(handed(true), (path.clone(), false), "an open that creates");
		let (given, pinned) = handed(false);
		if proc {
			assert!(
				pinned && given.starts_with("/proc/self/fd"),
				"an open that does not create was handed {given:?}, pinned {pinned}"
			);
		} else {
			assert_eq!((given, pinned), (path.clone(), false), "an open that does not create");
		}
		assert_eq!(routes::of(&path), [false, proc], "the helpers' record");
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
		let opened = helper(&path, Slot { hold: true, ..Slot::default() }, true, write_end);
		let shared = Arc::clone(&opened.shared);
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
		assert_eq!(routes::of(&path), [false], "the helper's route was not the path");
		assert!(
			ended,
			"the helper the drop left had not ended after {LIMIT:?}: it opened the new FIFO"
		);
		assert!(!in_open && !writer, "the helper the drop left opened the new FIFO");
	}

	/// The probe of the test below, run by the helper just before its open:
	/// the FIFO the open started on is moved to `<path>.a`, and a new FIFO
	/// takes the path, so the helper's open of the path waits on the new one.
	/// A path it cannot move (a helper handed the pin's `/proc/self/fd/N`)
	/// answers no, so the helper skips its open and the test fails at once.
	fn swap_in_another_fifo(path: &Path) -> bool {
		if fs::rename(path, path.with_extension("a")).is_err() {
			return false;
		}
		make_fifo(path);
		true
	}

	/// A drop returns within its bound though its helper waits on another
	/// FIFO and the path names the pinned FIFO again when the drop looks:
	/// the path was given to another FIFO for the helper's open (a write
	/// open that creates, so by the path), then given back. The drop's end
	/// cannot reach the other FIFO, so it leaves the helper there and holds
	/// no end of the pinned FIFO once it returns. A drop that waited for the
	/// helper would wait until the other FIFO's reader opens, holding both
	/// ends of the pinned FIFO. The other FIFO's reader then ends the helper.
	#[test]
	fn a_drop_returns_while_its_helper_waits_on_a_fifo_moved_away_from_the_path() {
		const LIMIT: Duration = Duration::from_secs(10);
		let (_dir, path) = new_fifo();
		let (aside, other) = (path.with_extension("a"), path.with_extension("b"));
		let slot = Slot { probe: Some(swap_in_another_fifo), ..Slot::default() };
		let opened = helper(&path, slot, true, write_end);
		let shared = Arc::clone(&opened.shared);
		let start = std::time::Instant::now();
		while shared.slot.lock().peer_held.is_none() && start.elapsed() < LIMIT {
			thread::yield_now();
		}
		let peer_held = shared.slot.lock().peer_held;
		assert_eq!(peer_held, Some(true), "the helper was not handed the path it could swap");
		// The helper is in `open(2)` of the other FIFO, waiting for a reader.
		thread::sleep(Duration::from_millis(500));
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
