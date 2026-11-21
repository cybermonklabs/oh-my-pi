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
/// behind once the drop returns, but for a helper that opens a path that
/// names another FIFO (below). A helper that has not passed its check of
/// the cancel opens nothing, and a result it stored that was not taken is
/// closed. A helper that passed its check is in `open(2)`, or about to enter
/// it: the drop holds the FIFO open for reading and writing, which never
/// waits on a FIFO and completes that open whether it waits already or not
/// yet, until the helper has ended, closing what it got. The FIFO's real
/// other end can observe that brief peer, as it can every release: a writer
/// that comes and goes reads as end of file, a reader that comes and goes
/// makes a writer's first write fail with `EPIPE`. Other opens of the same
/// end waiting at that moment are released with it.
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
/// procfs, where the drop opens the path too while it names the FIFO) is
/// waited for only while the path names the FIFO the open started on: the
/// drop checks the path every [`POLL_SLICE`] until the helper has ended, and
/// leaves the helper once the path names another file. If the path was
/// given to another FIFO before the helper's open (`rm p; mkfifo p`), the
/// helper waits on that FIFO, which the drop's end does not reach: it stays
/// in `open(2)` until that FIFO's other end opens, then takes that
/// connection and closes it.
///
/// What is left: a FIFO this process may not open for both reading and
/// writing keeps its helper until its other end opens; the helper then takes
/// that connection and closes it. Without procfs, a path that no longer
/// names the FIFO when the drop starts leaves the helper waiting too.
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

impl<T> Drop for FifoOpen<T> {
	/// See [`FifoOpen`]: leaves no end of the FIFO behind once it returns,
	/// but for a helper that opens a path that names another FIFO.
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
			#[cfg(test)]
			{
				self.shared.slot.lock().left = true;
			}
			return;
		};
		#[cfg(test)]
		{
			self.shared.slot.lock().joining = true;
		}
		if !self.node.reopens() {
			// The helper opens the path: wait for it only while the path
			// names the FIFO, whose open `peer` completes.
			let mut s = self.shared.slot.lock();
			while !s.exited {
				drop(s);
				if !self.node.named() {
					#[cfg(test)]
					{
						self.shared.slot.lock().left = true;
					}
					return;
				}
				s = self.shared.slot.lock();
				if !s.exited {
					self.shared.done.wait_for(&mut s, POLL_SLICE);
				}
			}
		}
		let _ = helper.join();
		drop(peer);
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
	/// the helper (see [`FifoOpen`], "What is left"); the helper waits on the
	/// old FIFO (or on the new one, had it not opened before the rename)
	/// until a writer of it opens, which this test then is. The old FIFO is
	/// moved aside, not removed, so the new one cannot reuse its inode number
	/// and pass for it.
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
		assert!(!writers.is_empty(), "the helper ended with no writer of its FIFO");
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
	/// new one, and the drop returns all the same (a drop that waits for the
	/// helper hangs the test until the runner's bound). The new FIFO's next
	/// reader then completes the helper's open, and the helper ends, closing
	/// its end. The old FIFO is moved aside, not removed, so the new one
	/// cannot reuse its inode number and pass for it.
	#[test]
	fn a_drop_leaves_a_helper_whose_path_names_another_fifo_before_it_opens() {
		let (_dir, path) = new_fifo();
		let opened = helper(&path, Slot { hold: true, ..Slot::default() }, true, write_end);
		let shared = Arc::clone(&opened.shared);
		while !shared.slot.lock().opening {
			thread::yield_now();
		}
		fs::rename(&path, path.with_extension("old")).unwrap();
		make_fifo(&path);
		drop(opened);
		assert!(shared.slot.lock().left, "the drop did not leave the helper");
		let mut reader = fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&path)
			.unwrap();
		while Arc::strong_count(&shared) != 1 {
			thread::yield_now();
		}
		assert_eq!(routes::of(&path), [false], "the helper did not open the path");
		assert_eq!(reader.read(&mut [0; 1]).ok(), Some(0), "the helper's end stayed open");
	}
}
