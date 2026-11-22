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
/// The FIFO is the one the open started on ([`FifoPin`]). Where
/// `/proc/self/fd` is there (Linux with `/proc`), the drop opens it through
/// the pin's `/proc/self/fd/N`, so it reaches that FIFO whatever its name
/// holds later, and so does the helper, unless the open has `O_CREAT`
/// (`creates`): that helper opens the name with the caller's own options,
/// so the kernel's check of the name applies (`fs.protected_fifos` in a
/// sticky directory, which `may_create_in_sticky` reads only under
/// `O_CREAT`; the checks of `O_TRUNC` and `O_EXCL` hold through the magic
/// link). Elsewhere (off Linux, and on Linux without `/proc`) the helper and
/// the drop open the name, and the drop opens it only while the name names
/// the pinned FIFO, before and after its open (a peer of another FIFO is
/// closed at once).
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
/// its last check, just before `open(2)`, opens nothing. One past it waits on
/// B, which no release reaches: the drop's peer is of the pinned FIFO. The
/// helper thread then stays in `open(2)`, holding the pin (and, for a
/// directory entry, a duplicate of the directory's descriptor), until B's
/// next peer connects; if B's name goes first (a script that ends with
/// `rm p`), nothing can open B again, and they stay for the life of the
/// process. A reader peer of B then reads end of file; a writer peer's
/// writes before the helper's end closes land in B's buffer and are lost,
/// and its later writes fail with `EPIPE`. That is a trade-off: a release of
/// B by name would reach that helper, but it would also complete every
/// other open waiting on B's same end, a FIFO the open never pinned; keeping
/// a release from reaching a FIFO its open did not start on is what the pin
/// is for.
///
/// The helper's open of the name never truncates for a write: the caller
/// leaves `O_TRUNC` out of it, and the helper applies it itself, under the
/// open's lock and only while the open has not been dropped, to a regular
/// file the name names by then (see [`TruncateRegular`]; a FIFO ignores
/// `O_TRUNC`). A helper whose open was dropped closes what it opened at once,
/// unchanged. A write asks the write permission `O_TRUNC` asks anyway; a
/// read-only open that asks for `O_TRUNC` keeps it, so the kernel still asks
/// that permission, and so does the reopen of the pin, which opens the FIFO.
///
/// What is left: a FIFO this process may not open for both reading and
/// writing keeps its helper until its other end opens; the helper then takes
/// that connection and closes it. A FIFO that nothing pinned (gone, or no
/// FIFO, by the pin) is never released. A helper held up for longer than the
/// bound between its last check and its `open(2)` (a loaded node can hold a
/// thread that long) opens the name after the drop has gone. It writes
/// nothing, and closes what it opened at once; until then it holds its thread
/// and the pin. Where the name still names the FIFO, it waits there until the
/// other end opens, which then sees end of file (a writer's first write fails
/// with `EPIPE`). A write's helper truncates nothing; a read-only open that
/// asks for `O_TRUNC` keeps it (above), so its helper truncates a regular file
/// the name names by then, as that open asks.
///
/// Where the name names nothing by then, an open that creates leaves an empty
/// regular file there, as the open would have, and nothing else. That cannot
/// be avoided: the open needs `O_CREAT` so that the kernel checks
/// `fs.protected_fifos` when the name names a FIFO, and `O_CREAT` creates a
/// missing file in the same `open(2)`. Removing that file afterwards would
/// remove by its name a file the helper cannot prove is the one it created.
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
	/// The drop left the helper: a helper that has not passed its last
	/// check opens nothing.
	abandoned: bool,
	/// Test hook: the helper passed its last check, of `abandoned`, just
	/// before its `open(2)`.
	#[cfg(test)]
	in_open:   bool,
	/// The helper has ended.
	exited:    bool,
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
	/// Test hook: the drop returned without joining the helper (nothing to
	/// release, or a helper that opens a name that names another file), so a
	/// helper a test holds stops holding.
	#[cfg(test)]
	left:      bool,
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
			#[cfg(test)]
			hold:                   false,
			#[cfg(test)]
			joining:                false,
			#[cfg(test)]
			probe:                  None,
			#[cfg(test)]
			peer_held:              None,
			#[cfg(test)]
			left:                   false,
		}
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

	/// Opens the FIFO at the name for reading and writing without blocking.
	fn open_both_ends(&self) -> io::Result<fs::File> {
		let (dir, name, follow) = self.dir_and_name()?;
		let flags = libc::O_RDWR
			| libc::O_NONBLOCK
			| libc::O_CLOEXEC
			| if follow { 0 } else { libc::O_NOFOLLOW };
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
	/// the pin: nothing identifies it, and nothing releases the open.
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
	/// drop's peer. Through the pin's `/proc/self/fd/N`, else by name while
	/// the name names the pinned FIFO. `None` when nothing is pinned, or
	/// when the open fails or reaches another file.
	fn peer(&self) -> Option<fs::File> {
		let pin = self.pin.as_ref()?;
		let peer = if let Some(reopen) = &self.reopen {
			fs::OpenOptions::new()
				.read(true)
				.write(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(reopen)
				.ok()?
		} else {
			if !self.name.names(pin) {
				return None;
			}
			self.name.open_both_ends().ok()?
		};
		// A peer of another FIFO is closed at once.
		pin.is(peer.as_fd()).then_some(peer)
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
		Self::start_node(Node { truncates, ..Node::new(path, meta, nofollow, creates) }, open)
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
		Self::start_node(Node { truncates, ..Node::pinned(pin, name, creates) }, open)
	}

	fn start_node<F>(node: Node, open: F) -> Self
	where
		F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
	{
		let node = Arc::new(node);
		let shared = Arc::new(Shared { slot: Mutex::new(Slot::default()), done: Condvar::new() });
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
	T: TruncateRegular + Send + 'static,
	F: FnOnce(&Path, bool) -> io::Result<T> + Send + 'static,
{
	thread::Builder::new()
		.name("fifo-open".to_owned())
		.stack_size(64 << 10)
		.spawn(move || {
			let _exit = Exit(Arc::clone(&shared));
			#[cfg(test)]
			let _end = hooks::End(node.name.path().to_path_buf());
			#[cfg(test)]
			let after = seam::before_open();
			{
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
			}
			#[cfg(test)]
			{
				let seam_hold = seam::reached_after_check();
				let held = || {
					let s = shared.slot.lock();
					(s.hold || seam_hold) && !s.joining && !s.left
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
			if s.cancelled {
				// A helper whose open was dropped, or that the drop has left:
				// what it opened is closed here, unchanged.
				return;
			}
			// The caller's `O_TRUNC` for an open of the name, applied under
			// the lock: a drop that comes now waits for it, and one that came
			// first was seen above.
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

impl<T> Drop for FifoOpen<T> {
	/// See [`FifoOpen`]: leaves no end of the FIFO behind once it returns,
	/// but for a helper it cannot reach: one whose open waits on another
	/// FIFO, which it leaves there. It waits for a helper that opens the name
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
/// of what the name names), and a record of the helpers that have ended.
#[cfg(test)]
pub(crate) mod hooks {
	use std::path::{Path, PathBuf};

	use parking_lot::Mutex;

	type Hook = (PathBuf, Box<dyn FnOnce() + Send>);

	static BEFORE_OPEN: Mutex<Vec<Hook>> = Mutex::new(Vec::new());
	static ENDED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

	/// Runs `hook` once, in the next helper of an open given `name`, just
	/// before its open.
	#[cfg_attr(not(target_os = "linux"), allow(dead_code, reason = "only Linux tests use it"))]
	pub(crate) fn before_open(name: &Path, hook: impl FnOnce() + Send + 'static) {
		BEFORE_OPEN
			.lock()
			.push((name.to_path_buf(), Box::new(hook)));
	}

	pub(crate) fn run_before_open(name: &Path) {
		let hook = {
			let mut hooks = BEFORE_OPEN.lock();
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
		let opened = FifoOpen::start(path, &fs::metadata(path).unwrap(), false, false, false, open);
		while !opened.shared.slot.lock().opening {
			thread::yield_now();
		}
		opened
	}

	fn helper(path: &Path, slot: Slot<fs::File>, open: Open) -> FifoOpen<fs::File> {
		let node = Arc::new(Node::new(path, &fs::metadata(path).unwrap(), false, false));
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
	/// path now names another FIFO. The path never names nothing: it reaches
	/// its FIFO through a symbolic link to a directory, which turns from the
	/// old FIFO's directory to the new one's in one `rename(2)`, so the
	/// helper's open of the path finds one FIFO or the other. Both FIFOs keep
	/// their names, so neither inode number can be reused for the other. (A
	/// hard link of a FIFO, the other way to keep the old one's name, failed
	/// with `EOPNOTSUPP` under gVisor.)
	#[cfg(target_os = "linux")]
	#[test]
	fn a_drop_releases_a_helper_whose_path_now_names_another_fifo() {
		let (dir, _old) = new_fifo();
		let other = dir.0.join("b");
		fs::create_dir(&other).unwrap();
		make_fifo(&other.join("f"));
		// `l/f`, with `l` naming the directory itself: the old FIFO.
		let link = dir.0.join("l");
		std::os::unix::fs::symlink(".", &link).unwrap();
		let path = link.join("f");
		let opened = opening(&path, read_end);
		let shared = Arc::clone(&opened.shared);
		let turned = dir.0.join("l.b");
		std::os::unix::fs::symlink("b", &turned).unwrap();
		fs::rename(&turned, &link).unwrap();
		drop(opened);
		assert_eq!(Arc::strong_count(&shared), 1, "the helper outlived the drop");
		assert!(!has_reader(&path));
	}

	/// The name the probe of the test below swaps: a pin's probe is given
	/// the pin's `/proc/self/fd/N`, not the name.
	static SWAPPED: Mutex<Option<PathBuf>> = Mutex::new(None);

	/// The probe of the test below, run by the helper just before its open:
	/// the pinned FIFO is moved to `<name>.a`, and a new FIFO takes the name,
	/// so the helper's open of the name waits on the new one.
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
	/// the pinned FIFO. The other FIFO's reader then ends the helper.
	#[test]
	fn a_drop_returns_while_its_helper_waits_on_a_fifo_moved_away_from_the_name() {
		const LIMIT: Duration = Duration::from_secs(10);
		let (_dir, path) = new_fifo();
		let (aside, other) = (path.with_extension("a"), path.with_extension("b"));
		*SWAPPED.lock() = Some(path.clone());
		let node = Arc::new(Node::new(&path, &fs::metadata(&path).unwrap(), false, true));
		let slot = Slot { probe: Some(swap_in_another_fifo), ..Slot::default() };
		let shared = Arc::new(Shared { slot: Mutex::new(slot), done: Condvar::new() });
		let helper = spawn_helper(Arc::clone(&shared), Arc::clone(&node), write_end).unwrap();
		let opened = FifoOpen { shared: Arc::clone(&shared), node, helper: Some(helper) };
		let start = std::time::Instant::now();
		while shared.slot.lock().peer_held.is_none() && start.elapsed() < LIMIT {
			thread::yield_now();
		}
		let peer_held = shared.slot.lock().peer_held;
		assert_eq!(peer_held, Some(true), "the helper's probe could not swap the name");
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
