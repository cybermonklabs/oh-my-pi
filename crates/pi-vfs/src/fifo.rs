//! One end of a FIFO opened on a helper thread ([`FifoOpen`]).

use std::{
	fs, io,
	os::{
		fd::OwnedFd,
		unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
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
pub struct FifoOpen<T> {
	shared: Arc<Shared<T>>,
	node:   Arc<Node>,
	helper: Option<thread::JoinHandle<()>>,
}

/// What an open and its helper share.
struct Shared<T> {
	slot: Mutex<Slot<T>>,
	/// Notified once the helper has stored its result.
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
			hold:                   false,
			#[cfg(test)]
			joining:                false,
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
		use std::os::{fd::FromRawFd, unix::ffi::OsStrExt};
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
		let node = Arc::new(Node::new(path, meta, nofollow));
		let shared = Arc::new(Shared { slot: Mutex::new(Slot::default()), done: Condvar::new() });
		let helper = match spawn_helper(Arc::clone(&shared), Arc::clone(&node), open) {
			Ok(helper) => Some(helper),
			Err(e) => {
				shared.slot.lock().result = Some(Err(e));
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
			}
			let opened = catch_unwind(AssertUnwindSafe(|| open(&node.path, node.pinned())))
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
	/// See [`FifoOpen`]: leaves no end of the FIFO behind once it returns.
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
			let _ = helper.join();
		}
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
	/// path now names another FIFO.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_drop_releases_a_helper_whose_path_now_names_another_fifo() {
		let (_dir, path) = new_fifo();
		let opened = opening(&path, read_end);
		let shared = Arc::clone(&opened.shared);
		fs::remove_file(&path).unwrap();
		make_fifo(&path);
		drop(opened);
		assert_eq!(Arc::strong_count(&shared), 1, "the helper outlived the drop");
		assert!(!has_reader(&path));
	}
}
