//! The [`Fs`] (async) and [`BlockingFs`] (sync) facades.
//!
//! Every operation routes its path first: descriptor overlays
//! ([`Fs::mount_file`]) win, then host paths go straight to `std`/libc
//! (no futures, no boxing) when there is no provider or the provider declares
//! them [`FileSystem::is_native_local`], and everything else is awaited on
//! the provider. A URL reaching a facade without a provider is `NotFound`;
//! it is never resolved against the process working directory.

#[cfg(unix)]
use std::{ffi::CStr, os::fd::RawFd};
use std::{
	ffi::{OsStr, OsString},
	fmt,
	hash::{BuildHasher, Hasher, RandomState},
	io::{self, Seek, SeekFrom},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};

use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
use crate::file::POLL_SLICE;
use crate::{
	dir::{EntryBinding, ReadDir},
	dir_handle::DirHandle,
	error::{
		already_exists, invalid_argument, no_provider, not_a_directory, not_permitted,
		permission_denied, unsupported,
	},
	file::{COPY_CHUNK, File},
	metadata::Metadata,
	native,
	options::{CanonicalizeOptions, DirOptions, OpenOptions, TempOptions},
	path::{is_virtual_path, join_path},
	provider::FileSystem,
	runtime::{CloseTracker, Scope, block_on, offload},
	types::{FileId, FileTime, NodeKind, Permissions, StatFs, SymlinkKind},
};

/// A path pinned to an already-open file (`/dev/stdin`, `/dev/fd/N`, ...).
struct Mount {
	path: PathBuf,
	file: File,
}

enum Route<'a> {
	Native,
	Provider(&'a Arc<dyn FileSystem>),
	Mounted(&'a File),
}

enum PairRoute<'a> {
	Native,
	Provider(&'a Arc<dyn FileSystem>),
}

/// Cloneable asynchronous filesystem; the default is the host filesystem.
///
/// Clones, [`Fs::blocking`] views, [`Fs::with_cancellation`] views, and
/// [`Fs::mount_file`] overlays share one provider and one close tracker.
#[derive(Clone, Default)]
pub struct Fs {
	provider: Option<Arc<dyn FileSystem>>,
	mounts:   Option<Arc<Vec<Arc<Mount>>>>,
	scope:    Scope,
}

impl fmt::Debug for Fs {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let mounts: Vec<&Path> = self
			.mounts
			.iter()
			.flat_map(|mounts| mounts.iter())
			.map(|m| m.path.as_path())
			.collect();
		f.debug_struct("Fs")
			.field("provider", &self.provider)
			.field("mounts", &mounts)
			.field("cancellable", &self.scope.cancel.is_some())
			.finish()
	}
}

/// Synchronous twin of [`Fs`] for blocking workers and foreign threads.
///
/// Host operations are direct syscalls; provider operations are driven to
/// completion on the calling thread (see the crate docs for the threading
/// contract). Never call provider-backed operations from a current-thread
/// runtime's own thread.
#[derive(Clone, Default)]
pub struct BlockingFs {
	fs:      Fs,
	runtime: Option<Handle>,
}

impl fmt::Debug for BlockingFs {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_tuple("BlockingFs").field(&self.fs).finish()
	}
}

const TEMP_ATTEMPTS: u32 = 1 << 16;

fn random_name(len: usize) -> String {
	const ALPHABET: &[u8; 62] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let state = RandomState::new();
	let mut out = String::with_capacity(len);
	let (mut word, mut left) = (0u64, 0u32);
	while out.len() < len {
		if left == 0 {
			let mut hasher = state.build_hasher();
			hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
			hasher.write_u128(
				SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.map_or(0, |d| d.as_nanos()),
			);
			hasher.write_u32(std::process::id());
			word = hasher.finish();
			left = 10;
		}
		out.push(ALPHABET[(word % 62) as usize] as char);
		word /= 62;
		left -= 1;
	}
	out
}

fn temp_file_options(options: &TempOptions) -> OpenOptions {
	let mut open = OpenOptions::new();
	open
		.read(true)
		.write(true)
		.create_new(true)
		.mode(options.get_mode().unwrap_or(0o600));
	open
}

fn temp_dir_options(options: &TempOptions) -> DirOptions {
	DirOptions::new().mode(options.get_mode().unwrap_or(0o700))
}

/// The facade's creation mask where it applies: Unix host creations. Windows
/// creation modes merely toggle the read-only attribute, which a umask must
/// never reach.
fn host_mask(scope: &Scope) -> Option<u32> {
	scope.creation_mask.filter(|_| cfg!(unix))
}

/// Opens a host path under the facade's creation mask: a file the open
/// creates gets exactly its requested mode (`0o666` by default) less the
/// mask. The mask replaces the process umask, which the kernel still applies
/// on creation, so the new file's mode is set again afterwards: a looser mask
/// (`umask 000`) must keep the bits the process umask clears.
fn native_open(scope: &Scope, path: &Path, options: &OpenOptions) -> io::Result<File> {
	let Some(mask) = host_mask(scope) else {
		return native::open(path, options);
	};
	if !(options.is_create() || options.is_create_new()) {
		return native::open(path, options);
	}
	let mode = options.get_mode().unwrap_or(0o666) & !mask;
	let mut masked = options.clone();
	masked.mode(mode);
	// Only an exclusive create proves the file is new; an existing file keeps
	// its mode.
	let mut exclusive = masked.clone();
	exclusive.create_new(true);
	match native::open(path, &exclusive) {
		Ok(file) => {
			// Best effort: without it the file keeps the stricter mode the
			// process umask left.
			let _ = file.set_permissions(Permissions::from_mode(mode));
			Ok(file)
		},
		Err(err) if err.kind() == io::ErrorKind::AlreadyExists && !options.is_create_new() => {
			native::open(path, &masked)
		},
		Err(err) => Err(err),
	}
}

/// What a host open under a facade does, decided by [`plan_scoped_open`].
enum ScopedOpen {
	/// Open, then bind the file to the scope (see [`File::bind`]).
	Plain,
	/// Open a file whose type is known: `poll` when its reads can block (see
	/// [`crate::reads_can_block`]), so binding it takes no `fstat`.
	#[cfg(unix)]
	Typed { token: CancellationToken, poll: bool },
	/// Open one end of a FIFO, which waits until the other end connects, so
	/// the wait goes through [`FifoOpening`], which the token can interrupt.
	/// `pin` is the FIFO at the path when the pin was taken, just after the
	/// `stat` ([`FifoPin`]; a FIFO put there in between is the one pinned);
	/// `None` when it was gone by then, and the open then has no release.
	#[cfg(unix)]
	Fifo { token: CancellationToken, end: FifoEnd, pin: Option<FifoPin> },
}

/// Under a cancellable scope on Unix, a read-only or write-only open takes
/// one `stat` first. It says whether the file's reads must poll (see
/// [`crate::reads_can_block`]) and whether the open itself can block: a
/// FIFO's open waits for the other end, unless the open never waits on a
/// FIFO it finds ([`FifoEnd::of`]). Without a token, for any other open, or
/// when the `stat` fails, the open is [`ScopedOpen::Plain`]. If the path
/// changes between the `stat` and the open, the file is opened as the `stat`
/// described it.
#[cfg_attr(not(unix), allow(clippy::missing_const_for_fn, reason = "const only off Unix"))]
fn plan_scoped_open(scope: &Scope, path: &Path, options: &OpenOptions) -> ScopedOpen {
	#[cfg(unix)]
	if let Some(token) = &scope.cancel
		&& !options.is_create_new()
	{
		use std::os::unix::{ffi::OsStrExt, fs::FileTypeExt};
		match (options.is_read(), options.is_writable()) {
			(true, false) if !options.is_create() => {},
			(false, true) => {},
			_ => return ScopedOpen::Plain,
		}
		let Ok(meta) = std::fs::metadata(path) else {
			return ScopedOpen::Plain;
		};
		if meta.file_type().is_fifo()
			&& let Some(end) = FifoEnd::of(options)
		{
			let follow = options.get_custom_flags() & libc::O_NOFOLLOW == 0;
			let pin = std::ffi::CString::new(path.as_os_str().as_bytes())
				.ok()
				.and_then(|path| FifoPin::at(libc::AT_FDCWD, &path, follow).ok().flatten());
			return ScopedOpen::Fifo { token: token.clone(), end, pin };
		}
		return ScopedOpen::Typed { token: token.clone(), poll: crate::reads_can_block(&meta) };
	}
	#[cfg(not(unix))]
	let _ = (scope, path, options);
	ScopedOpen::Plain
}

/// Opens a host path for a facade and binds the file to the facade's scope,
/// so its reads observe the scope's cancellation (see [`File`]). For blocking
/// callers; async callers use [`native_open_scoped_async`].
fn native_open_scoped(scope: &Scope, path: &Path, options: &OpenOptions) -> io::Result<File> {
	match plan_scoped_open(scope, path, options) {
		#[cfg(unix)]
		ScopedOpen::Typed { token, poll } => {
			Ok(native_open(scope, path, options)?.bind_host(token, poll))
		},
		#[cfg(unix)]
		ScopedOpen::Fifo { token, end, pin } => {
			Ok(FifoOpening::start(scope, path, options, end, pin, &token)?
				.wait(&token)?
				.bind_host(token, true))
		},
		ScopedOpen::Plain => Ok(native_open(scope, path, options)?.bind(scope)),
	}
}

/// [`native_open_scoped`] for async callers: a FIFO's wait for its other end
/// is awaited, so it never holds the runtime worker that end may need (a
/// background job queued on the same worker, as in `echo hi > f & cat < f`).
#[cfg_attr(
	not(unix),
	allow(clippy::unused_async, reason = "the FIFO wait is awaited only on Unix")
)]
async fn native_open_scoped_async(
	scope: &Scope,
	path: &Path,
	options: &OpenOptions,
) -> io::Result<File> {
	match plan_scoped_open(scope, path, options) {
		#[cfg(unix)]
		ScopedOpen::Typed { token, poll } => {
			Ok(native_open(scope, path, options)?.bind_host(token, poll))
		},
		#[cfg(unix)]
		ScopedOpen::Fifo { token, end, pin } => {
			Ok(FifoOpening::start(scope, path, options, end, pin, &token)?
				.wait_async(&token)
				.await?
				.bind_host(token, true))
		},
		ScopedOpen::Plain => Ok(native_open(scope, path, options)?.bind(scope)),
	}
}

/// The end of a FIFO an open takes.
#[cfg(unix)]
#[derive(Clone, Copy)]
pub(crate) enum FifoEnd {
	/// Waits for a writer.
	Read,
	/// Waits for a reader.
	Write,
}

#[cfg(unix)]
impl FifoEnd {
	/// The end of a FIFO an open with `options` waits on: a read-only open
	/// that creates nothing, or a write-only one, without `O_NONBLOCK`.
	/// `None` for every other open, and for one that never waits on a FIFO
	/// it finds: one the plain open refuses before it looks at the entry
	/// (`EINVAL`: truncating or creating without write access, or appending
	/// with truncation, the combinations `std` refuses), and an exclusive
	/// create (`create_new`, or a custom `O_EXCL` with `create` or a custom
	/// `O_CREAT`), which fails with `EEXIST` on any entry. Those take the
	/// plain open, which gives their error.
	pub(crate) const fn of(options: &OpenOptions) -> Option<Self> {
		let custom = options.get_custom_flags();
		let creates = options.is_create() || custom & libc::O_CREAT != 0;
		if options.is_create_new()
			|| (creates && custom & libc::O_EXCL != 0)
			|| custom & libc::O_NONBLOCK != 0
		{
			return None;
		}
		let (write, append, truncate) =
			(options.is_write(), options.is_append(), options.is_truncate());
		if (!write && !append && (truncate || options.is_create())) || (append && truncate) {
			return None;
		}
		match (options.is_read(), write || append) {
			(true, false) => Some(Self::Read),
			(false, true) => Some(Self::Write),
			_ => None,
		}
	}

	/// Whether a release of this end opens the write end.
	pub(crate) const fn released_by_writer(self) -> bool {
		matches!(self, Self::Read)
	}

	/// A non-blocking open of the other end, which releases a waiting open
	/// of this end and closes at once.
	fn release_options(self) -> OpenOptions {
		let mut release = OpenOptions::new();
		match self {
			Self::Read => release.write(true),
			Self::Write => release.read(true),
		};
		release.custom_flags(libc::O_NONBLOCK);
		release
	}
}

/// How many times a cancelled or dropped [`FifoOpening`] tries to release
/// its helper's open, one poll slice apart (about a second in all), before it
/// leaves the helper blocked.
#[cfg(unix)]
pub(crate) const FIFO_RELEASE_ATTEMPTS: usize = 10;

/// The FIFO an open started on, pinned so that the open and its releases
/// reach it ([`FifoOpening::start_pinned`]).
///
/// On Linux it holds an `O_PATH` descriptor of the FIFO, taken when the open
/// starts and kept until the open and every release of it have ended. An
/// `O_PATH` open runs no `fifo_open`, so it is neither a reader nor a writer.
/// While it is open the FIFO's inode is not freed, so its number goes to no
/// other file (ext4 and overlayfs on it give a freed number to the next file
/// made, often the FIFO made at the same name: `rm p; mkfifo p`). Where
/// `/proc/self/fd` is there, each release opens the other end through
/// `/proc/self/fd/N` of it, so it reaches this FIFO whatever its name holds
/// later; the helper opens its end there too, unless the open creates or
/// truncates: it then opens the name with the caller's options, so the
/// kernel's checks of the name apply ([`creates_or_truncates`]).
///
/// Elsewhere (macOS) a FIFO cannot be held without opening one of its ends,
/// so the pin is the (device, inode) of a `stat`, which a FIFO made later at
/// a reused number would share (APFS does not reuse numbers soon).
#[cfg(unix)]
pub(crate) struct FifoPin {
	dev: u64,
	ino: u64,
	#[cfg(target_os = "linux")]
	fd:  std::os::fd::OwnedFd,
}

#[cfg(unix)]
#[allow(clippy::unnecessary_cast, reason = "stat field widths differ by platform")]
impl FifoPin {
	/// Pins the FIFO `name` names relative to the directory `dir`
	/// (`AT_FDCWD` for a path), following a final symlink only with
	/// `follow`. `Ok(None)` when it is no FIFO.
	#[cfg(target_os = "linux")]
	pub(crate) fn at(dir: RawFd, name: &CStr, follow: bool) -> io::Result<Option<Self>> {
		use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
		let flags = libc::O_PATH | libc::O_CLOEXEC | if follow { 0 } else { libc::O_NOFOLLOW };
		// SAFETY: `name` is NUL-terminated.
		let raw = unsafe { libc::openat(dir, name.as_ptr(), flags) };
		if raw < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `raw` was just opened, and nothing else owns it.
		let fd = unsafe { OwnedFd::from_raw_fd(raw) };
		let st = fstat(fd.as_raw_fd())?;
		let pin = is_fifo(&st).then(|| Self { dev: st.st_dev as u64, ino: st.st_ino as u64, fd });
		#[cfg(test)]
		if pin.is_some() {
			fifo_seam::fire_after_pin();
		}
		Ok(pin)
	}

	/// Pins the FIFO `name` names relative to the directory `dir`
	/// (`AT_FDCWD` for a path), following a final symlink only with
	/// `follow`. `Ok(None)` when it is no FIFO.
	#[cfg(not(target_os = "linux"))]
	pub(crate) fn at(dir: RawFd, name: &CStr, follow: bool) -> io::Result<Option<Self>> {
		let flag = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
		let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `name` is NUL-terminated and `st` is a valid out-pointer.
		if unsafe { libc::fstatat(dir, name.as_ptr(), st.as_mut_ptr(), flag) } == -1 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `fstatat` succeeded and filled `st`.
		let st = unsafe { st.assume_init() };
		let pin = is_fifo(&st).then_some(Self { dev: st.st_dev as u64, ino: st.st_ino as u64 });
		#[cfg(test)]
		if pin.is_some() {
			fifo_seam::fire_after_pin();
		}
		Ok(pin)
	}

	/// `/proc/self/fd/N` of the pin, where the open and its releases reach
	/// the FIFO; `None` off Linux and without `/proc`, when they open the
	/// name and a release checks what it opened ([`Self::check`]).
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
			use std::os::fd::AsRawFd;
			static PROC_FD: std::sync::LazyLock<bool> =
				std::sync::LazyLock::new(|| Path::new("/proc/self/fd").is_dir());
			#[cfg(test)]
			if fifo_seam::by_name() {
				return None;
			}
			let proc = *PROC_FD;
			proc.then(|| PathBuf::from(format!("/proc/self/fd/{}", self.fd.as_raw_fd())))
		}
		#[cfg(not(target_os = "linux"))]
		None
	}

	/// `Ok` when `end`, an end a release opened by name, is of the pinned
	/// FIFO; else an error, and the release closes it at once and stops. Its
	/// open has happened by then, though: an end of another FIFO at the name
	/// has completed an open waiting there (a reader then reads end of file).
	fn check(&self, end: std::os::fd::BorrowedFd<'_>) -> io::Result<()> {
		use std::os::fd::AsRawFd;
		let st = fstat(end.as_raw_fd())?;
		if (st.st_dev as u64, st.st_ino as u64) == (self.dev, self.ino) {
			Ok(())
		} else {
			Err(io::Error::other("the FIFO's name now names another FIFO; no release"))
		}
	}
}

#[cfg(unix)]
fn fstat(fd: RawFd) -> io::Result<libc::stat> {
	let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `st` is a valid out-pointer.
	if unsafe { libc::fstat(fd, st.as_mut_ptr()) } == -1 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `fstat` succeeded and filled `st`.
	Ok(unsafe { st.assume_init() })
}

#[cfg(unix)]
const fn is_fifo(st: &libc::stat) -> bool {
	st.st_mode & libc::S_IFMT == libc::S_IFIFO
}

/// Whether an open with `options` asks to create or truncate: `create`,
/// `truncate` or `create_new`, or `O_CREAT`, `O_EXCL` or `O_TRUNC` among
/// the custom flags. The kernel checks such an open against the name it
/// opens (`EEXIST`, the write permission `O_TRUNC` asks even of a
/// read-only open, `fs.protected_fifos` in a sticky directory), so a pinned
/// FIFO's helper runs it by name with the caller's own options, never
/// through `/proc/self/fd/N`, whose magic link those checks do not see.
#[cfg(unix)]
const fn creates_or_truncates(options: &OpenOptions) -> bool {
	options.is_create()
		|| options.is_truncate()
		|| options.is_create_new()
		|| options.get_custom_flags() & (libc::O_CREAT | libc::O_EXCL | libc::O_TRUNC) != 0
}

/// `options`, which neither create nor truncate ([`creates_or_truncates`]),
/// for an open of a pinned FIFO through `/proc/self/fd/N`: without
/// `O_NOFOLLOW`, which would refuse the magic link itself.
#[cfg(unix)]
fn reopen_options(options: &OpenOptions) -> OpenOptions {
	debug_assert!(!creates_or_truncates(options), "a creating open goes by name");
	let mut reopen = options.clone();
	reopen.custom_flags(options.get_custom_flags() & !libc::O_NOFOLLOW);
	reopen
}

/// A non-blocking open of the other end of the FIFO a [`FifoOpening`] opens;
/// `ENXIO` while no open of this end waits yet. The end it returns stays
/// open until the wait for the helper's answer ends, so a helper that
/// reaches its `open` during that wait connects to it.
#[cfg(unix)]
pub(crate) type FifoRelease = Arc<dyn Fn() -> io::Result<Box<dyn Send>> + Send + Sync>;

/// One end of a FIFO being opened on a helper thread, so that the wait for
/// the other end observes a token and, for async callers, holds no runtime
/// worker. The helper runs the ordinary blocking open, so the open returns
/// exactly when it would without a token: once the other end connects.
///
/// Once the token fires, a non-blocking open of the other end connects to
/// the waiting open and closes at once; it is tried again while the helper
/// has not reached `open` yet, one poll slice apart, for about a second
/// ([`FIFO_RELEASE_ATTEMPTS`]). The helper's descriptor is closed, and the
/// open fails with [`crate::cancelled`]. Other opens of the same end waiting
/// at that moment are released too: a reader reads EOF, a writer's first
/// write fails with `EPIPE`. On Linux the releases reach the FIFO the open
/// started on, whatever its name holds later ([`FifoPin`]), and so does the
/// helper, unless the open creates or truncates: the helper then opens the
/// name with the caller's options ([`creates_or_truncates`]). Elsewhere the
/// helper and its releases open the name, and a release that reached
/// another FIFO closes it at once and stops.
///
/// An open that is dropped before it finishes (the job that made it was
/// aborted, its run task was dropped) is released the same way, on a
/// detached thread after the first attempt. A helper that reaches `open`
/// after the last attempt, about a second on, still takes the next
/// connection of the other end and closes it.
///
/// When the release fails (this process may not open the other end: a FIFO
/// it can read but not write, or the reverse), the open still fails with
/// [`crate::cancelled`], but the helper stays blocked in `open` until the
/// other end arrives. It then takes that connection and closes it: the next
/// writer's first write fails with `EPIPE`, the next reader reads EOF. Without
/// a token the whole command would have stayed blocked there instead.
#[cfg(unix)]
pub(crate) struct FifoOpening {
	release: FifoRelease,
	opened:  std::sync::mpsc::Receiver<io::Result<File>>,
	/// Notified once the helper has sent its result.
	done:    Arc<tokio::sync::Notify>,
	/// Whether the open has ended: its result was taken, or it was released.
	settled: bool,
}

#[cfg(unix)]
impl FifoOpening {
	/// Opens `end` of the FIFO at `path` under `scope`; `pin` is the FIFO the
	/// open started on.
	fn start(
		scope: &Scope,
		path: &Path,
		options: &OpenOptions,
		end: FifoEnd,
		pin: Option<FifoPin>,
		token: &CancellationToken,
	) -> io::Result<Self> {
		let (scope, owned_path, open_options) = (scope.clone(), path.to_path_buf(), options.clone());
		let (release_path, release_options) = (path.to_path_buf(), end.release_options().to_std());
		Self::start_pinned(
			pin,
			end,
			options,
			move || native_open(&scope, &owned_path, &open_options),
			move || release_options.open(&release_path),
			token,
		)
	}

	/// Starts the open of `end` of the pinned FIFO `pin` on a helper thread.
	/// With a reopen path ([`FifoPin`]), each release opens the other end
	/// there, and the helper opens it with `options` (no `O_NOFOLLOW`),
	/// unless the open creates or truncates ([`creates_or_truncates`]): that
	/// helper runs `by_name`, the plain open by name with the caller's own
	/// options, so the kernel checks it as it checks the plain open. Without
	/// a reopen path, the helper runs `by_name` and each release runs
	/// `release_by_name`, a non-blocking open of the other end at the name,
	/// whose end the pin then checks. Both keep the pin until they end, so
	/// its descriptor is not closed, nor its number given to another file,
	/// while they can use it. Whether this process may open the other end
	/// is the release's own open to find (`EACCES`), never a check of the
	/// name, which can name another file, or none, by then. Without a pin
	/// there is no release.
	pub(crate) fn start_pinned(
		pin: Option<FifoPin>,
		end: FifoEnd,
		options: &OpenOptions,
		by_name: impl FnOnce() -> io::Result<File> + Send + 'static,
		release_by_name: impl Fn() -> io::Result<std::fs::File> + Send + Sync + 'static,
		token: &CancellationToken,
	) -> io::Result<Self> {
		use std::os::fd::AsFd;
		let Some(pin) = pin.map(Arc::new) else {
			// Nothing identifies the FIFO (it was gone when the open started).
			let refuse: FifoRelease = Arc::new(|| Err(io::Error::other("no FIFO pinned; no release")));
			#[cfg(test)]
			fifo_seam::note_helper(fifo_seam::Helper::ByName);
			return Self::spawn(by_name, refuse, token);
		};
		let (open_pin, release_pin) = (Arc::clone(&pin), pin);
		let reopens = release_pin.reopen_path().is_some();
		let gone = || io::Error::other("the FIFO's pin has no reopen path");
		let open: Box<dyn FnOnce() -> io::Result<File> + Send> =
			if reopens && !creates_or_truncates(options) {
				#[cfg(test)]
				fifo_seam::note_helper(fifo_seam::Helper::Reopen);
				let open_options = reopen_options(options).to_std();
				Box::new(move || {
					let path = open_pin.reopen_path().ok_or_else(gone)?;
					open_options.open(path).map(File::from)
				})
			} else {
				#[cfg(test)]
				fifo_seam::note_helper(fifo_seam::Helper::ByName);
				Box::new(move || {
					let opened = by_name();
					drop(open_pin);
					opened
				})
			};
		let release: FifoRelease = if reopens {
			let release_options = end.release_options().to_std();
			Arc::new(move || {
				let path = release_pin.reopen_path().ok_or_else(gone)?;
				Ok(Box::new(release_options.open(path)?) as Box<dyn Send>)
			})
		} else {
			Arc::new(move || {
				let end = release_by_name()?;
				release_pin.check(end.as_fd())?;
				Ok(Box::new(end) as Box<dyn Send>)
			})
		};
		Self::spawn(open, release, token)
	}

	/// Runs `open`, a blocking open of one end of a FIFO, on a helper thread;
	/// `release` opens the other end without blocking.
	pub(crate) fn spawn(
		open: impl FnOnce() -> io::Result<File> + Send + 'static,
		release: FifoRelease,
		token: &CancellationToken,
	) -> io::Result<Self> {
		if token.is_cancelled() {
			return Err(crate::cancelled());
		}
		let (sender, opened) = std::sync::mpsc::sync_channel(1);
		let done = Arc::new(tokio::sync::Notify::new());
		let notify = done.clone();
		std::thread::Builder::new()
			.name("pi-vfs-fifo-open".to_owned())
			.spawn(move || {
				#[cfg(test)]
				let after = fifo_seam::before_open();
				let opened = open();
				#[cfg(test)]
				if let Some(after) = after {
					after(opened.is_ok());
				}
				// After a cancellation nobody receives; the file then closes here.
				let _ = sender.send(opened);
				notify.notify_one();
			})?;
		Ok(Self { release, opened, done, settled: false })
	}

	/// Waits for the open on this thread, in poll slices, checking `token`.
	pub(crate) fn wait(mut self, token: &CancellationToken) -> io::Result<File> {
		use std::sync::mpsc::RecvTimeoutError;
		loop {
			match self.opened.recv_timeout(POLL_SLICE) {
				Ok(result) => {
					self.settled = true;
					return result;
				},
				Err(RecvTimeoutError::Disconnected) => {
					self.settled = true;
					return Err(helper_exited());
				},
				Err(RecvTimeoutError::Timeout) if token.is_cancelled() => return self.cancel(),
				Err(RecvTimeoutError::Timeout) => {},
			}
		}
	}

	/// Awaits the open or `token`, whichever comes first.
	pub(crate) async fn wait_async(mut self, token: &CancellationToken) -> io::Result<File> {
		tokio::select! {
			biased;
			() = self.done.notified() => {},
			() = token.cancelled() => {},
		}
		match self.opened.try_recv() {
			Ok(result) => {
				self.settled = true;
				result
			},
			Err(std::sync::mpsc::TryRecvError::Disconnected) => {
				self.settled = true;
				Err(helper_exited())
			},
			Err(std::sync::mpsc::TryRecvError::Empty) => self.cancel(),
		}
	}

	/// Ends a cancelled open: releases the helper's open. The release takes
	/// microseconds unless the helper has not reached `open` yet, and is
	/// bounded by [`FIFO_RELEASE_ATTEMPTS`] slices.
	fn cancel(mut self) -> io::Result<File> {
		release_fifo_open(&*self.release, &self.opened);
		self.settled = true;
		Err(crate::cancelled())
	}
}

#[cfg(unix)]
impl Drop for FifoOpening {
	/// Releases an open dropped before it ended. The first attempt runs here,
	/// so the release is done, and the helper's descriptor closed, before what
	/// follows the drop (the next command) opens this FIFO; it takes
	/// microseconds when the helper waits in `open`. A helper that has not
	/// answered one slice into it is left to a detached thread that tries
	/// again for about a second ([`FIFO_RELEASE_ATTEMPTS`]), so that no
	/// runtime worker waits for it.
	fn drop(&mut self) {
		if self.settled {
			return;
		}
		if release_attempt(&*self.release, &self.opened) {
			return;
		}
		let (_, placeholder) = std::sync::mpsc::sync_channel(0);
		let opened = std::mem::replace(&mut self.opened, placeholder);
		let release = Arc::clone(&self.release);
		let _ = std::thread::Builder::new()
			.name("pi-vfs-fifo-release".to_owned())
			.spawn(move || release_fifo_open(&*release, &opened));
	}
}

/// Releases a helper's open of one end of a FIFO; see [`release_attempt`].
/// Bounded by [`FIFO_RELEASE_ATTEMPTS`] attempts.
#[cfg(unix)]
fn release_fifo_open(
	release: &(dyn Fn() -> io::Result<Box<dyn Send>> + Send + Sync),
	opened: &std::sync::mpsc::Receiver<io::Result<File>>,
) {
	for _ in 0..FIFO_RELEASE_ATTEMPTS {
		if release_attempt(release, opened) {
			break;
		}
	}
}

/// One attempt to release a helper's open of one end of a FIFO: a
/// non-blocking open of the other end (`release`), kept open while this waits
/// one poll slice for the helper's result, which is dropped after it, so the
/// helper's end, closed second, is the last of the two. `false` when another
/// attempt is due: the helper has not answered (it has not reached `open`
/// yet, or, for a writer's release, `ENXIO`). `true` also when the release
/// failed otherwise, a release that reached another FIFO included.
#[cfg(unix)]
fn release_attempt(
	release: &(dyn Fn() -> io::Result<Box<dyn Send>> + Send + Sync),
	opened: &std::sync::mpsc::Receiver<io::Result<File>>,
) -> bool {
	use std::sync::mpsc::RecvTimeoutError;
	let released = release();
	#[cfg(test)]
	fifo_seam::after_release(released.is_ok());
	let held = match released {
		Ok(held) => Some(held),
		Err(err) if err.raw_os_error() == Some(libc::ENXIO) => None,
		Err(_) => return true,
	};
	let answer = opened.recv_timeout(POLL_SLICE);
	drop(held);
	let answered = !matches!(answer, Err(RecvTimeoutError::Timeout));
	drop(answer);
	answered
}

/// Test seams: a hook a test sets for the next FIFO helper, run on the
/// helper's thread before its `open` (it may block, to hold the helper back)
/// and after it (told whether the open succeeded); a hook run after each
/// release's open of the other end, while the end it opened is still held
/// (told whether it opened one); a hook run just after the next FIFO pin is
/// taken; a record of the way each pinned FIFO's helper opens it; and a
/// switch that makes pinned FIFO opens open the name, as they do without
/// `/proc`.
#[cfg(all(test, unix))]
pub(crate) mod fifo_seam {
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

	/// The way a FIFO's helper opens it.
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub(crate) enum Helper {
		/// By the name, with the caller's own options (`by_name`).
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
	/// check what a release opened, as without `/proc` (`on`), or not.
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

	/// Hooks every release attempt in this process from now on.
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

#[cfg(unix)]
fn helper_exited() -> io::Error {
	io::Error::other("FIFO open thread exited")
}

/// Reads a whole host file. Under a cancellable scope the read goes through
/// [`File`], so it stops when the token fires instead of draining the file
/// (`/dev/zero`, a large sparse file); otherwise it is `std::fs::read`.
fn native_read(scope: &Scope, path: &Path) -> io::Result<Vec<u8>> {
	if scope.cancel.is_none() {
		return std::fs::read(path);
	}
	let mut file = native_open_scoped(scope, path, &read_options())?;
	let mut contents = Vec::new();
	io::Read::read_to_end(&mut file, &mut contents)?;
	Ok(contents)
}

/// [`native_read`] for async callers. Under a cancellable scope the read runs
/// off the runtime worker (see [`offload`]): it never yields while it reads
/// (`/dev/zero` never ends) or waits (a FIFO's writer), so on the worker it
/// would hold the very task that cancels it.
async fn native_read_async(scope: &Scope, path: &Path) -> io::Result<Vec<u8>> {
	if scope.cancel.is_none() {
		return std::fs::read(path);
	}
	let (scope, path) = (scope.clone(), path.to_path_buf());
	offload(move || native_read(&scope, &path)).await
}

/// Creates a host directory under the facade's creation mask: each directory
/// it creates gets exactly its requested mode (`0o777` by default) less the
/// mask, set again after creation as in [`native_open`]. Existing ones keep
/// their modes.
fn native_create_dir(
	scope: &Scope,
	path: &Path,
	mode: Option<u32>,
	recursive: bool,
) -> io::Result<()> {
	let Some(mask) = host_mask(scope) else {
		return native::create_dir(path, mode, recursive);
	};
	let mode = mode.unwrap_or(0o777) & !mask;
	if recursive {
		create_dir_all_exact(path, mode)
	} else {
		create_dir_exact(path, mode)
	}
}

/// Creates one directory with exactly `mode`.
fn create_dir_exact(path: &Path, mode: u32) -> io::Result<()> {
	native::create_dir(path, Some(mode), false)?;
	// Best effort, as for files.
	let _ = native::set_permissions(path, Permissions::from_mode(mode));
	Ok(())
}

/// [`create_dir_exact`] for each missing directory up to `path`, walked as
/// `std::fs::create_dir_all` walks them.
fn create_dir_all_exact(path: &Path, mode: u32) -> io::Result<()> {
	if path.is_empty() {
		return Ok(());
	}
	match create_dir_exact(path, mode) {
		Ok(()) => return Ok(()),
		Err(err) if err.kind() == io::ErrorKind::NotFound => {},
		Err(_) if path.is_dir() => return Ok(()),
		Err(err) => return Err(err),
	}
	match path.parent() {
		Some(parent) => create_dir_all_exact(parent, mode)?,
		None => return Err(io::Error::other("failed to create whole tree")),
	}
	match create_dir_exact(path, mode) {
		Ok(()) => Ok(()),
		Err(_) if path.is_dir() => Ok(()),
		Err(err) => Err(err),
	}
}

/// Creates a host node under the facade's creation mask, with exactly its
/// requested mode less the mask, as in [`native_open`].
fn native_make_node(scope: &Scope, path: &Path, kind: NodeKind, mode: u32) -> io::Result<()> {
	let Some(mask) = host_mask(scope) else {
		return native::make_node(path, kind, mode);
	};
	let mode = mode & !mask;
	native::make_node(path, kind, mode)?;
	// Best effort, as for files.
	let _ = native::set_permissions(path, Permissions::from_mode(mode));
	Ok(())
}

fn too_many_temps() -> io::Error {
	io::Error::new(io::ErrorKind::AlreadyExists, "too many temporary files exist")
}

fn into_utf8(bytes: Vec<u8>) -> io::Result<String> {
	String::from_utf8(bytes)
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "stream did not contain valid UTF-8"))
}

fn identity_result(a: io::Result<FileId>, b: io::Result<FileId>) -> io::Result<bool> {
	match (a, b) {
		(Ok(a), Ok(b)) => Ok(a == b),
		(Err(err), _) | (_, Err(err)) if err.kind() == io::ErrorKind::Unsupported => Ok(false),
		(Err(err), _) | (_, Err(err)) => Err(err),
	}
}

fn not_found_is_false(result: io::Result<Metadata>) -> io::Result<bool> {
	match result {
		Ok(_) => Ok(true),
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
		Err(err) => Err(err),
	}
}

fn blocks_to_bytes(metadata: &Metadata) -> io::Result<u64> {
	metadata
		.blocks()
		.map(|blocks| blocks * 512)
		.ok_or_else(|| unsupported("allocated size"))
}

// Descriptor overlay semantics: opening re-uses the pinned file (shared
// offset, like `dup`), truncation/append apply to regular files, and
// namespace mutations are refused.

fn mount_open(file: &File, options: &OpenOptions) -> io::Result<File> {
	if options.is_create_new() {
		return Err(already_exists());
	}
	let clone = file.try_clone()?;
	if (options.is_truncate() || options.is_append()) && clone.metadata()?.is_file() {
		if options.is_truncate() && options.is_writable() {
			clone.set_len(0)?;
			(&clone).seek(SeekFrom::Start(0))?;
		}
		if options.is_append() {
			(&clone).seek(SeekFrom::End(0))?;
		}
	}
	Ok(clone)
}

async fn mount_open_async(file: &File, options: &OpenOptions) -> io::Result<File> {
	if options.is_create_new() {
		return Err(already_exists());
	}
	let clone = file.try_clone()?;
	if (options.is_truncate() || options.is_append()) && clone.metadata_async().await?.is_file() {
		if options.is_truncate() && options.is_writable() {
			clone.set_len_async(0).await?;
			clone.seek_async(SeekFrom::Start(0)).await?;
		}
		if options.is_append() {
			clone.seek_async(SeekFrom::End(0)).await?;
		}
	}
	Ok(clone)
}

fn mount_access(execute: bool) -> io::Result<()> {
	if execute {
		Err(permission_denied())
	} else {
		Ok(())
	}
}

fn mount_stat_fs(file: &File) -> io::Result<StatFs> {
	match file.native() {
		Some(native) => native::fstat_fs(native),
		None => Err(unsupported("statfs")),
	}
}

fn read_options() -> OpenOptions {
	let mut options = OpenOptions::new();
	options.read(true);
	options
}

fn create_options() -> OpenOptions {
	let mut options = OpenOptions::new();
	options.write(true).create(true).truncate(true);
	options
}

impl Fs {
	/// The host filesystem.
	pub fn native() -> Self {
		Self::default()
	}

	/// A filesystem backed by `provider`.
	pub fn new(provider: Arc<dyn FileSystem>) -> Self {
		Self {
			provider: Some(provider),
			mounts:   None,
			scope:    Scope {
				cancel:        None,
				closes:        Some(Arc::new(CloseTracker::default())),
				creation_mask: None,
			},
		}
	}

	/// Synchronous view; captures the current tokio runtime (if any) to drive
	/// provider calls from threads outside it.
	pub fn blocking(&self) -> BlockingFs {
		BlockingFs { fs: self.clone(), runtime: Handle::try_current().ok() }
	}

	/// No provider is installed.
	pub const fn is_native(&self) -> bool {
		self.provider.is_none()
	}

	pub const fn provider(&self) -> Option<&Arc<dyn FileSystem>> {
		self.provider.as_ref()
	}

	/// Same provider and overlays (cancellation scope is not compared).
	pub fn ptr_eq(&self, other: &Self) -> bool {
		let providers = match (&self.provider, &other.provider) {
			(None, None) => true,
			(Some(a), Some(b)) => std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b)),
			_ => false,
		};
		let mounts = match (&self.mounts, &other.mounts) {
			(None, None) => true,
			(Some(a), Some(b)) => Arc::ptr_eq(a, b),
			_ => false,
		};
		providers && mounts
	}

	/// `path` and everything below it are plain host filesystem objects, so
	/// host fast paths (fd traversal, native walkers, mmap) may bypass this
	/// facade. Always `false` for URLs and descriptor overlays.
	pub fn is_native_local(&self, path: impl AsRef<Path>) -> bool {
		matches!(self.route(path.as_ref()), Ok(Route::Native))
	}

	/// A view whose provider operations, data operations on provider files
	/// opened through it, and reads of host files opened through it fail with
	/// [`crate::cancelled`] once `token` is cancelled. Closes are never
	/// cancelled; other host operations are unaffected.
	pub fn with_cancellation(&self, token: CancellationToken) -> Self {
		let mut fs = self.clone();
		fs.scope.cancel = Some(token);
		fs
	}

	/// A view whose host file, directory, and node creations get exactly
	/// their requested mode less `mask`, as if `mask` were the process umask,
	/// so a shell can scope its `umask` to itself; `None` leaves creations to
	/// the process umask. The kernel still applies the process umask, so each
	/// new entry's mode is set again after it is created. Unix only; providers
	/// and other platforms ignore it.
	pub fn with_creation_mask(&self, mask: Option<u32>) -> Self {
		let mut fs = self.clone();
		fs.scope.creation_mask = mask;
		fs
	}

	/// The mask set by [`Fs::with_creation_mask`].
	pub const fn creation_mask(&self) -> Option<u32> {
		self.scope.creation_mask
	}

	/// The same filesystem without cancellation, for deleting the caller's
	/// own temporary artifacts in `Drop`/error paths after a cancelled run.
	/// Providers may substitute a cleanup view ([`FileSystem::for_cleanup`]).
	pub fn for_cleanup(&self) -> Self {
		let mut fs = self.clone();
		fs.scope.cancel = None;
		if let Some(cleanup) = self
			.provider
			.as_ref()
			.and_then(|provider| provider.for_cleanup())
		{
			fs.provider = Some(cleanup);
		}
		fs
	}

	/// A view in which `path` names `file` itself (descriptor overlay), e.g.
	/// `/dev/stdin` for a provider-backed stdin. Opening the path re-uses the
	/// file (shared offset), metadata comes from the file, timestamps and
	/// permissions apply to it, and namespace mutations fail with `EPERM`.
	pub fn mount_file(&self, path: impl Into<PathBuf>, file: File) -> Self {
		let path = path.into();
		let mut mounts: Vec<Arc<Mount>> = self
			.mounts
			.iter()
			.flat_map(|mounts| mounts.iter())
			.filter(|mount| mount.path != path)
			.cloned()
			.collect();
		mounts.push(Arc::new(Mount { path, file }));
		let mut fs = self.clone();
		fs.mounts = Some(Arc::new(mounts));
		fs
	}

	/// Waits for background closes of provider files that were dropped
	/// without [`File::close`], returning the first close error.
	pub async fn drain_closes(&self) -> io::Result<()> {
		match &self.scope.closes {
			Some(closes) => closes.drain().await,
			None => Ok(()),
		}
	}

	fn mounted(&self, path: &Path) -> Option<&File> {
		self
			.mounts
			.as_ref()?
			.iter()
			.find(|mount| mount.path == path)
			.map(|mount| &mount.file)
	}

	/// Whether a descriptor overlay is mounted below `path`, which a host
	/// directory handle would reach past.
	fn mounts_below(&self, path: &Path) -> bool {
		self
			.mounts
			.as_ref()
			.is_some_and(|mounts| mounts.iter().any(|mount| mount.path.starts_with(path)))
	}

	fn route(&self, path: &Path) -> io::Result<Route<'_>> {
		if let Some(file) = self.mounted(path) {
			return Ok(Route::Mounted(file));
		}
		match &self.provider {
			None if is_virtual_path(path) => Err(no_provider(path)),
			None => Ok(Route::Native),
			Some(provider) if provider.is_native_local(path) => Ok(Route::Native),
			Some(provider) => Ok(Route::Provider(provider)),
		}
	}

	fn route_pair(&self, a: &Path, b: &Path) -> io::Result<PairRoute<'_>> {
		match (self.route(a)?, self.route(b)?) {
			(Route::Mounted(_), _) | (_, Route::Mounted(_)) => Err(not_permitted()),
			(Route::Native, Route::Native) => Ok(PairRoute::Native),
			(Route::Provider(provider), _) | (_, Route::Provider(provider)) => {
				Ok(PairRoute::Provider(provider))
			},
		}
	}

	async fn guard<T>(&self, fut: impl Future<Output = io::Result<T>>) -> io::Result<T> {
		Scope::guard(self.scope.cancel.as_ref(), fut).await
	}

	fn entry_binding(
		&self,
		provider: &Arc<dyn FileSystem>,
		runtime: Option<Handle>,
	) -> EntryBinding {
		EntryBinding { provider: Arc::clone(provider), runtime, cancel: self.scope.cancel.clone() }
	}

	pub async fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
		self.open_with(path, &read_options()).await
	}

	/// Opens for writing, creating or truncating.
	pub async fn create(&self, path: impl AsRef<Path>) -> io::Result<File> {
		self.open_with(path, &create_options()).await
	}

	pub async fn open_with(
		&self,
		path: impl AsRef<Path>,
		options: &OpenOptions,
	) -> io::Result<File> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native_open_scoped_async(&self.scope, path, options).await,
			Route::Provider(provider) => Ok(self
				.guard(provider.open(path, options))
				.await?
				.bind(&self.scope)),
			Route::Mounted(file) => mount_open_async(file, options).await,
		}
	}

	/// Creates a uniquely named file in `dir` (`create_new`, retried on
	/// collisions) and returns its path and read/write handle.
	pub async fn create_temp(
		&self,
		dir: impl AsRef<Path>,
		options: &TempOptions,
	) -> io::Result<(PathBuf, File)> {
		let dir = dir.as_ref();
		let open = temp_file_options(options);
		let attempts = if options.get_random_len() == 0 {
			1
		} else {
			TEMP_ATTEMPTS
		};
		for _ in 0..attempts {
			let path =
				join_path(dir, Path::new(&options.name(&random_name(options.get_random_len()))));
			match self.open_with(&path, &open).await {
				Ok(file) => return Ok((path, file)),
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists && attempts > 1 => {},
				Err(err) => return Err(err),
			}
		}
		Err(too_many_temps())
	}

	/// Creates a uniquely named directory in `dir`.
	pub async fn create_temp_dir(
		&self,
		dir: impl AsRef<Path>,
		options: &TempOptions,
	) -> io::Result<PathBuf> {
		let dir = dir.as_ref();
		let create = temp_dir_options(options);
		let attempts = if options.get_random_len() == 0 {
			1
		} else {
			TEMP_ATTEMPTS
		};
		for _ in 0..attempts {
			let path =
				join_path(dir, Path::new(&options.name(&random_name(options.get_random_len()))));
			match self.create_dir_with(&path, &create).await {
				Ok(()) => return Ok(path),
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists && attempts > 1 => {},
				Err(err) => return Err(err),
			}
		}
		Err(too_many_temps())
	}

	pub async fn read(&self, path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native_read_async(&self.scope, path).await,
			Route::Provider(provider) => self.guard(provider.read(path)).await,
			Route::Mounted(file) => {
				let file = mount_open_async(file, &read_options()).await?;
				let mut contents = Vec::new();
				file.read_to_end_async(&mut contents).await?;
				Ok(contents)
			},
		}
	}

	pub async fn read_to_string(&self, path: impl AsRef<Path>) -> io::Result<String> {
		into_utf8(self.read(path).await?)
	}

	/// Replaces the contents of `path`, creating it if needed.
	pub async fn write(&self, path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
		let (path, contents) = (path.as_ref(), contents.as_ref());
		match self.route(path)? {
			Route::Native => std::fs::write(path, contents),
			Route::Provider(provider) => self.guard(provider.write(path, contents)).await,
			Route::Mounted(file) => {
				mount_open_async(file, &create_options())
					.await?
					.write_all_async(contents)
					.await
			},
		}
	}

	pub async fn metadata(&self, path: impl AsRef<Path>) -> io::Result<Metadata> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::metadata(path),
			Route::Provider(provider) => self.guard(provider.metadata(path)).await,
			Route::Mounted(file) => file.metadata_async().await,
		}
	}

	pub async fn symlink_metadata(&self, path: impl AsRef<Path>) -> io::Result<Metadata> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::symlink_metadata(path),
			Route::Provider(provider) => self.guard(provider.symlink_metadata(path)).await,
			Route::Mounted(file) => file.metadata_async().await,
		}
	}

	async fn metadata_follow(&self, path: &Path, follow: bool) -> io::Result<Metadata> {
		if follow {
			self.metadata(path).await
		} else {
			self.symlink_metadata(path).await
		}
	}

	/// Opens the directory at `path` as a [`DirHandle`], below which every
	/// call names one entry: a descriptor on the host, the path on a provider.
	/// Earlier components are followed; with `follow` the last is too.
	/// Without, a symlink that is the last component is refused (`ENOTDIR` on
	/// Unix, also on a kernel that follows one despite `O_NOFOLLOW`;
	/// `ERROR_STOPPED_ON_SYMLINK` on Windows; [`not_a_directory`] on a
	/// provider). A host handle keeps this facade's creation mask and
	/// cancellation for the files and directories it creates and opens. A
	/// host directory with a descriptor overlay mounted below it opens as a
	/// path handle on this facade ([`Self::open_dir_by_path`]), so its calls
	/// reach the overlay, as this facade's own calls do.
	///
	/// # Errors
	///
	/// The open's errors; [`not_a_directory`] for anything else, a descriptor
	/// overlay included.
	pub async fn open_dir(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<DirHandle> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native if !self.mounts_below(path) => {
				DirHandle::open_host(path, follow, &self.scope)
			},
			Route::Native | Route::Provider(_) => {
				DirHandle::open_provider(self, Handle::try_current().ok(), path, follow).await
			},
			Route::Mounted(_) => Err(not_a_directory()),
		}
	}

	/// Opens the directory at `path` as a handle that names its entries by
	/// path on this facade, whatever serves them: each call joins the entry's
	/// name to `path` and makes this facade's path call, which routes it as
	/// the facade routes any path. Where this facade serves `path` from the
	/// host, [`Self::open_dir`] opens a host handle instead; a walk that
	/// started below a provider's root keeps to paths with this call. The
	/// directory is checked to be one, a final symlink followed only with
	/// `follow`.
	///
	/// # Errors
	///
	/// The facade's metadata errors; [`not_a_directory`] for anything else, a
	/// descriptor overlay included.
	pub async fn open_dir_by_path(
		&self,
		path: impl AsRef<Path>,
		follow: bool,
	) -> io::Result<DirHandle> {
		DirHandle::open_provider(self, Handle::try_current().ok(), path.as_ref(), follow).await
	}

	pub async fn read_dir(&self, path: impl AsRef<Path>) -> io::Result<ReadDir> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::read_dir(path),
			Route::Provider(provider) => {
				let read_dir = self.guard(provider.read_dir(path)).await?;
				Ok(read_dir.bind(self.entry_binding(provider, Handle::try_current().ok())))
			},
			Route::Mounted(_) => Err(not_a_directory()),
		}
	}

	/// `std::fs::canonicalize` semantics (every component must exist).
	pub async fn canonicalize(&self, path: impl AsRef<Path>) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::canonicalize(path),
			Route::Provider(provider) => {
				self
					.guard(provider.canonicalize(path, &CanonicalizeOptions::default()))
					.await
			},
			Route::Mounted(_) => Ok(path.to_path_buf()),
		}
	}

	/// uucore `canonicalize` semantics, URL-aware.
	pub async fn canonicalize_with(
		&self,
		path: impl AsRef<Path>,
		options: &CanonicalizeOptions,
	) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::canonicalize_with(path, *options),
			Route::Provider(provider) => self.guard(provider.canonicalize(path, options)).await,
			Route::Mounted(_) => Ok(path.to_path_buf()),
		}
	}

	/// The absolute host path a provider path aliases, if any (see
	/// [`FileSystem::backing_path`]); `None` for host paths.
	pub async fn backing_path(&self, path: impl AsRef<Path>) -> io::Result<Option<PathBuf>> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native | Route::Mounted(_) => Ok(None),
			Route::Provider(provider) => self.guard(provider.backing_path(path)).await,
		}
	}

	pub async fn read_link(&self, path: impl AsRef<Path>) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::read_link(path),
			Route::Provider(provider) => self.guard(provider.read_link(path)).await,
			Route::Mounted(_) => Err(invalid_argument()),
		}
	}

	pub async fn create_dir(&self, path: impl AsRef<Path>) -> io::Result<()> {
		self.create_dir_with(path, &DirOptions::new()).await
	}

	pub async fn create_dir_all(&self, path: impl AsRef<Path>) -> io::Result<()> {
		self
			.create_dir_with(path, &DirOptions::new().recursive(true))
			.await
	}

	pub async fn create_dir_with(
		&self,
		path: impl AsRef<Path>,
		options: &DirOptions,
	) -> io::Result<()> {
		let path = path.as_ref();
		let (mode, recursive) = (options.get_mode(), options.is_recursive());
		match self.route(path)? {
			Route::Native => native_create_dir(&self.scope, path, mode, recursive),
			Route::Provider(provider) if recursive => {
				self.guard(provider.create_dir_all(path, mode)).await
			},
			Route::Provider(provider) => self.guard(provider.create_dir(path, mode)).await,
			Route::Mounted(_) => Err(already_exists()),
		}
	}

	pub async fn remove_file(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::remove_file(path),
			Route::Provider(provider) => self.guard(provider.remove_file(path)).await,
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub async fn remove_dir(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::remove_dir(path),
			Route::Provider(provider) => self.guard(provider.remove_dir(path)).await,
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub async fn remove_dir_all(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::remove_dir_all(path),
			Route::Provider(provider) => self.guard(provider.remove_dir_all(path)).await,
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// Renames within one backend; across backends the provider reports
	/// `EXDEV` and nothing is copied.
	pub async fn rename(&self, from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
		let (from, to) = (from.as_ref(), to.as_ref());
		match self.route_pair(from, to)? {
			PairRoute::Native => std::fs::rename(from, to),
			PairRoute::Provider(provider) => self.guard(provider.rename(from, to)).await,
		}
	}

	/// Copies contents and permission bits; returns the byte count.
	pub async fn copy(&self, from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
		let (from, to) = (from.as_ref(), to.as_ref());
		match (self.route(from)?, self.route(to)?) {
			(Route::Native, Route::Native) => std::fs::copy(from, to),
			(Route::Mounted(_), _) | (_, Route::Mounted(_)) => {
				let source = self.open(from).await?;
				let target = self.create(to).await?;
				let mut chunk = vec![0; COPY_CHUNK];
				let mut copied = 0u64;
				loop {
					let n = source.read_async(&mut chunk).await?;
					if n == 0 {
						break;
					}
					target.write_all_async(&chunk[..n]).await?;
					copied += n as u64;
				}
				target.close_async().await?;
				Ok(copied)
			},
			(Route::Provider(provider), _) | (_, Route::Provider(provider)) => {
				self.guard(provider.copy(from, to)).await
			},
		}
	}

	pub async fn hard_link(
		&self,
		original: impl AsRef<Path>,
		link: impl AsRef<Path>,
	) -> io::Result<()> {
		let (original, link) = (original.as_ref(), link.as_ref());
		match self.route_pair(original, link)? {
			PairRoute::Native => std::fs::hard_link(original, link),
			PairRoute::Provider(provider) => self.guard(provider.hard_link(original, link)).await,
		}
	}

	/// Creates `link` pointing at `target` (stored verbatim). Windows picks a
	/// file or directory link from the target.
	pub async fn symlink(&self, target: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
		self.symlink_with(target, link, SymlinkKind::Auto).await
	}

	pub async fn symlink_with(
		&self,
		target: impl AsRef<Path>,
		link: impl AsRef<Path>,
		kind: SymlinkKind,
	) -> io::Result<()> {
		let (target, link) = (target.as_ref(), link.as_ref());
		match self.route(link)? {
			Route::Native => native::symlink(target, link, kind),
			Route::Provider(provider) => self.guard(provider.symlink(target, link, kind)).await,
			Route::Mounted(_) => Err(already_exists()),
		}
	}

	/// Follows symlinks.
	pub async fn set_permissions(
		&self,
		path: impl AsRef<Path>,
		permissions: Permissions,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::set_permissions(path, permissions),
			Route::Provider(provider) => {
				self
					.guard(provider.set_permissions(path, permissions))
					.await
			},
			Route::Mounted(file) => file.set_permissions_async(permissions).await,
		}
	}

	/// `utimensat`: [`FileTime::Omit`] keeps a timestamp, [`FileTime::Now`]
	/// uses the filesystem clock; `follow = false` updates a symlink itself.
	pub async fn set_times(
		&self,
		path: impl AsRef<Path>,
		accessed: impl Into<FileTime>,
		modified: impl Into<FileTime>,
		follow: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		let (accessed, modified) = (accessed.into(), modified.into());
		match self.route(path)? {
			Route::Native => native::set_times(path, accessed, modified, follow),
			Route::Provider(provider) => {
				self
					.guard(provider.set_times(path, accessed, modified, follow))
					.await
			},
			Route::Mounted(file) => file.set_times_async(accessed, modified).await,
		}
	}

	pub async fn chown(
		&self,
		path: impl AsRef<Path>,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::chown(path, uid, gid, follow),
			Route::Provider(provider) => self.guard(provider.chown(path, uid, gid, follow)).await,
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// `access(2)`; with every flag `false` it checks existence.
	pub async fn access(
		&self,
		path: impl AsRef<Path>,
		read: bool,
		write: bool,
		execute: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::access(path, read, write, execute),
			Route::Provider(provider) => {
				self
					.guard(provider.access(path, read, write, execute))
					.await
			},
			Route::Mounted(_) => mount_access(execute),
		}
	}

	/// `Ok(false)` only for `NotFound`; other errors propagate.
	pub async fn try_exists(&self, path: impl AsRef<Path>) -> io::Result<bool> {
		not_found_is_false(self.metadata(path).await)
	}

	/// Follows symlinks; any error is `false`.
	pub async fn exists(&self, path: impl AsRef<Path>) -> bool {
		self.metadata(path).await.is_ok()
	}

	pub async fn is_file(&self, path: impl AsRef<Path>) -> bool {
		self
			.metadata(path)
			.await
			.is_ok_and(|metadata| metadata.is_file())
	}

	pub async fn is_dir(&self, path: impl AsRef<Path>) -> bool {
		self
			.metadata(path)
			.await
			.is_ok_and(|metadata| metadata.is_dir())
	}

	pub async fn is_symlink(&self, path: impl AsRef<Path>) -> bool {
		self
			.symlink_metadata(path)
			.await
			.is_ok_and(|metadata| metadata.is_symlink())
	}

	/// Identity of the object at `path`; `Unsupported` when the backend has
	/// none.
	pub async fn file_id(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<FileId> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::file_id(path, follow),
			Route::Provider(_) => self
				.metadata_follow(path, follow)
				.await?
				.file_id()
				.ok_or_else(|| unsupported("file identity")),
			Route::Mounted(file) => file
				.metadata_async()
				.await?
				.file_id()
				.ok_or_else(|| unsupported("file identity")),
		}
	}

	/// Both paths name the same object (following symlinks); `false` when
	/// either backend has no identity to compare.
	pub async fn same_file(&self, a: impl AsRef<Path>, b: impl AsRef<Path>) -> io::Result<bool> {
		identity_result(self.file_id(a, true).await, self.file_id(b, true).await)
	}

	pub async fn link_count(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<u64> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::link_count(path, follow),
			Route::Provider(_) => self
				.metadata_follow(path, follow)
				.await?
				.nlink()
				.ok_or_else(|| unsupported("link count")),
			Route::Mounted(file) => file
				.metadata_async()
				.await?
				.nlink()
				.ok_or_else(|| unsupported("link count")),
		}
	}

	/// Bytes allocated on disk (following symlinks).
	pub async fn allocated_size(&self, path: impl AsRef<Path>) -> io::Result<u64> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::allocated_size(path),
			Route::Provider(_) => blocks_to_bytes(&self.metadata(path).await?),
			Route::Mounted(file) => blocks_to_bytes(&file.metadata_async().await?),
		}
	}

	pub async fn stat_fs(&self, path: impl AsRef<Path>) -> io::Result<StatFs> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::stat_fs(path),
			Route::Provider(provider) => self.guard(provider.stat_fs(path)).await,
			Route::Mounted(file) => mount_stat_fs(file),
		}
	}

	pub async fn list_xattr(
		&self,
		path: impl AsRef<Path>,
		follow: bool,
	) -> io::Result<Vec<OsString>> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::list_xattr(path, follow),
			Route::Provider(provider) => self.guard(provider.list_xattr(path, follow)).await,
			Route::Mounted(_) => Err(unsupported("listxattr")),
		}
	}

	/// `Ok(None)` when the attribute is absent.
	pub async fn get_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		follow: bool,
	) -> io::Result<Option<Vec<u8>>> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.route(path)? {
			Route::Native => native::get_xattr(path, name, follow),
			Route::Provider(provider) => self.guard(provider.get_xattr(path, name, follow)).await,
			Route::Mounted(_) => Err(unsupported("getxattr")),
		}
	}

	pub async fn set_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		value: &[u8],
		follow: bool,
	) -> io::Result<()> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.route(path)? {
			Route::Native => native::set_xattr(path, name, value, follow),
			Route::Provider(provider) => {
				self
					.guard(provider.set_xattr(path, name, value, follow))
					.await
			},
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub async fn remove_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		follow: bool,
	) -> io::Result<()> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.route(path)? {
			Route::Native => native::remove_xattr(path, name, follow),
			Route::Provider(provider) => self.guard(provider.remove_xattr(path, name, follow)).await,
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// `mkfifo(path, mode)` (umask applies).
	pub async fn make_fifo(&self, path: impl AsRef<Path>, mode: u32) -> io::Result<()> {
		self.make_node(path, NodeKind::Fifo, mode).await
	}

	/// `mknod(path, kind | mode, dev)` (umask applies).
	pub async fn make_node(
		&self,
		path: impl AsRef<Path>,
		kind: NodeKind,
		mode: u32,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native_make_node(&self.scope, path, kind, mode),
			Route::Provider(provider) => self.guard(provider.make_node(path, kind, mode)).await,
			Route::Mounted(_) => Err(already_exists()),
		}
	}
}

impl BlockingFs {
	/// The host filesystem.
	pub fn native() -> Self {
		Self::default()
	}

	/// The async facade this view wraps.
	pub const fn as_async(&self) -> &Fs {
		&self.fs
	}

	pub fn to_async(&self) -> Fs {
		self.fs.clone()
	}

	pub const fn is_native(&self) -> bool {
		self.fs.is_native()
	}

	pub const fn provider(&self) -> Option<&Arc<dyn FileSystem>> {
		self.fs.provider()
	}

	pub fn ptr_eq(&self, other: &Self) -> bool {
		self.fs.ptr_eq(&other.fs)
	}

	/// See [`Fs::is_native_local`].
	pub fn is_native_local(&self, path: impl AsRef<Path>) -> bool {
		self.fs.is_native_local(path)
	}

	/// See [`Fs::with_cancellation`].
	pub fn with_cancellation(&self, token: CancellationToken) -> Self {
		Self { fs: self.fs.with_cancellation(token), runtime: self.runtime.clone() }
	}

	/// See [`Fs::creation_mask`].
	pub const fn creation_mask(&self) -> Option<u32> {
		self.fs.scope.creation_mask
	}

	/// See [`Fs::mount_file`].
	pub fn mount_file(&self, path: impl Into<PathBuf>, file: File) -> Self {
		Self { fs: self.fs.mount_file(path, file), runtime: self.runtime.clone() }
	}

	/// See [`Fs::for_cleanup`].
	pub fn for_cleanup(&self) -> Self {
		Self { fs: self.fs.for_cleanup(), runtime: self.runtime.clone() }
	}

	/// See [`Fs::drain_closes`].
	pub fn drain_closes(&self) -> io::Result<()> {
		match &self.fs.scope.closes {
			Some(closes) => closes.drain_blocking(self.runtime.as_ref()),
			None => Ok(()),
		}
	}

	fn run<T>(&self, fut: impl Future<Output = io::Result<T>>) -> io::Result<T> {
		block_on(self.runtime.as_ref(), Scope::guard(self.fs.scope.cancel.as_ref(), fut))
	}

	pub fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
		self.open_with(path, &read_options())
	}

	/// Opens for writing, creating or truncating.
	pub fn create(&self, path: impl AsRef<Path>) -> io::Result<File> {
		self.open_with(path, &create_options())
	}

	pub fn open_with(&self, path: impl AsRef<Path>, options: &OpenOptions) -> io::Result<File> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native_open_scoped(&self.fs.scope, path, options),
			Route::Provider(provider) => {
				Ok(self.run(provider.open(path, options))?.bind(&self.fs.scope))
			},
			Route::Mounted(file) => mount_open(file, options),
		}
	}

	/// See [`Fs::create_temp`].
	pub fn create_temp(
		&self,
		dir: impl AsRef<Path>,
		options: &TempOptions,
	) -> io::Result<(PathBuf, File)> {
		let dir = dir.as_ref();
		let open = temp_file_options(options);
		let attempts = if options.get_random_len() == 0 {
			1
		} else {
			TEMP_ATTEMPTS
		};
		for _ in 0..attempts {
			let path =
				join_path(dir, Path::new(&options.name(&random_name(options.get_random_len()))));
			match self.open_with(&path, &open) {
				Ok(file) => return Ok((path, file)),
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists && attempts > 1 => {},
				Err(err) => return Err(err),
			}
		}
		Err(too_many_temps())
	}

	/// See [`Fs::create_temp_dir`].
	pub fn create_temp_dir(
		&self,
		dir: impl AsRef<Path>,
		options: &TempOptions,
	) -> io::Result<PathBuf> {
		let dir = dir.as_ref();
		let create = temp_dir_options(options);
		let attempts = if options.get_random_len() == 0 {
			1
		} else {
			TEMP_ATTEMPTS
		};
		for _ in 0..attempts {
			let path =
				join_path(dir, Path::new(&options.name(&random_name(options.get_random_len()))));
			match self.create_dir_with(&path, &create) {
				Ok(()) => return Ok(path),
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists && attempts > 1 => {},
				Err(err) => return Err(err),
			}
		}
		Err(too_many_temps())
	}

	pub fn read(&self, path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native_read(&self.fs.scope, path),
			Route::Provider(provider) => self.run(provider.read(path)),
			Route::Mounted(file) => {
				let mut contents = Vec::new();
				io::Read::read_to_end(&mut mount_open(file, &read_options())?, &mut contents)?;
				Ok(contents)
			},
		}
	}

	pub fn read_to_string(&self, path: impl AsRef<Path>) -> io::Result<String> {
		into_utf8(self.read(path)?)
	}

	/// Replaces the contents of `path`, creating it if needed.
	pub fn write(&self, path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
		let (path, contents) = (path.as_ref(), contents.as_ref());
		match self.fs.route(path)? {
			Route::Native => std::fs::write(path, contents),
			Route::Provider(provider) => self.run(provider.write(path, contents)),
			Route::Mounted(file) => {
				io::Write::write_all(&mut mount_open(file, &create_options())?, contents)
			},
		}
	}

	pub fn metadata(&self, path: impl AsRef<Path>) -> io::Result<Metadata> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::metadata(path),
			Route::Provider(provider) => self.run(provider.metadata(path)),
			Route::Mounted(file) => file.metadata(),
		}
	}

	pub fn symlink_metadata(&self, path: impl AsRef<Path>) -> io::Result<Metadata> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::symlink_metadata(path),
			Route::Provider(provider) => self.run(provider.symlink_metadata(path)),
			Route::Mounted(file) => file.metadata(),
		}
	}

	fn metadata_follow(&self, path: &Path, follow: bool) -> io::Result<Metadata> {
		if follow {
			self.metadata(path)
		} else {
			self.symlink_metadata(path)
		}
	}

	pub fn read_dir(&self, path: impl AsRef<Path>) -> io::Result<ReadDir> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::read_dir(path),
			Route::Provider(provider) => {
				let read_dir = self.run(provider.read_dir(path))?;
				let runtime = self.runtime.clone().or_else(|| Handle::try_current().ok());
				Ok(read_dir.bind(self.fs.entry_binding(provider, runtime)))
			},
			Route::Mounted(_) => Err(not_a_directory()),
		}
	}

	/// See [`Fs::open_dir`]. The handle's synchronous provider calls are
	/// driven as this facade drives its own.
	///
	/// # Errors
	///
	/// As for [`Fs::open_dir`].
	pub fn open_dir(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<DirHandle> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native if !self.fs.mounts_below(path) => {
				DirHandle::open_host(path, follow, &self.fs.scope)
			},
			Route::Native | Route::Provider(_) => {
				let runtime = self.runtime.clone().or_else(|| Handle::try_current().ok());
				block_on(
					self.runtime.as_ref(),
					DirHandle::open_provider(&self.fs, runtime, path, follow),
				)
			},
			Route::Mounted(_) => Err(not_a_directory()),
		}
	}

	/// See [`Fs::canonicalize`].
	pub fn canonicalize(&self, path: impl AsRef<Path>) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::canonicalize(path),
			Route::Provider(provider) => {
				self.run(provider.canonicalize(path, &CanonicalizeOptions::default()))
			},
			Route::Mounted(_) => Ok(path.to_path_buf()),
		}
	}

	/// See [`Fs::canonicalize_with`].
	pub fn canonicalize_with(
		&self,
		path: impl AsRef<Path>,
		options: &CanonicalizeOptions,
	) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::canonicalize_with(path, *options),
			Route::Provider(provider) => self.run(provider.canonicalize(path, options)),
			Route::Mounted(_) => Ok(path.to_path_buf()),
		}
	}

	/// See [`Fs::backing_path`].
	pub fn backing_path(&self, path: impl AsRef<Path>) -> io::Result<Option<PathBuf>> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native | Route::Mounted(_) => Ok(None),
			Route::Provider(provider) => self.run(provider.backing_path(path)),
		}
	}

	pub fn read_link(&self, path: impl AsRef<Path>) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::read_link(path),
			Route::Provider(provider) => self.run(provider.read_link(path)),
			Route::Mounted(_) => Err(invalid_argument()),
		}
	}

	pub fn create_dir(&self, path: impl AsRef<Path>) -> io::Result<()> {
		self.create_dir_with(path, &DirOptions::new())
	}

	pub fn create_dir_all(&self, path: impl AsRef<Path>) -> io::Result<()> {
		self.create_dir_with(path, &DirOptions::new().recursive(true))
	}

	pub fn create_dir_with(&self, path: impl AsRef<Path>, options: &DirOptions) -> io::Result<()> {
		let path = path.as_ref();
		let (mode, recursive) = (options.get_mode(), options.is_recursive());
		match self.fs.route(path)? {
			Route::Native => native_create_dir(&self.fs.scope, path, mode, recursive),
			Route::Provider(provider) if recursive => self.run(provider.create_dir_all(path, mode)),
			Route::Provider(provider) => self.run(provider.create_dir(path, mode)),
			Route::Mounted(_) => Err(already_exists()),
		}
	}

	pub fn remove_file(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::remove_file(path),
			Route::Provider(provider) => self.run(provider.remove_file(path)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub fn remove_dir(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::remove_dir(path),
			Route::Provider(provider) => self.run(provider.remove_dir(path)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub fn remove_dir_all(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::remove_dir_all(path),
			Route::Provider(provider) => self.run(provider.remove_dir_all(path)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// See [`Fs::rename`].
	pub fn rename(&self, from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
		let (from, to) = (from.as_ref(), to.as_ref());
		match self.fs.route_pair(from, to)? {
			PairRoute::Native => std::fs::rename(from, to),
			PairRoute::Provider(provider) => self.run(provider.rename(from, to)),
		}
	}

	/// See [`Fs::copy`].
	pub fn copy(&self, from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
		let (from, to) = (from.as_ref(), to.as_ref());
		match (self.fs.route(from)?, self.fs.route(to)?) {
			(Route::Native, Route::Native) => std::fs::copy(from, to),
			(Route::Mounted(_), _) | (_, Route::Mounted(_)) => {
				let source = self.open(from)?;
				let target = self.create(to)?;
				let copied = io::copy(&mut &source, &mut &target)?;
				target.close()?;
				Ok(copied)
			},
			(Route::Provider(provider), _) | (_, Route::Provider(provider)) => {
				self.run(provider.copy(from, to))
			},
		}
	}

	pub fn hard_link(&self, original: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
		let (original, link) = (original.as_ref(), link.as_ref());
		match self.fs.route_pair(original, link)? {
			PairRoute::Native => std::fs::hard_link(original, link),
			PairRoute::Provider(provider) => self.run(provider.hard_link(original, link)),
		}
	}

	/// See [`Fs::symlink`].
	pub fn symlink(&self, target: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
		self.symlink_with(target, link, SymlinkKind::Auto)
	}

	pub fn symlink_with(
		&self,
		target: impl AsRef<Path>,
		link: impl AsRef<Path>,
		kind: SymlinkKind,
	) -> io::Result<()> {
		let (target, link) = (target.as_ref(), link.as_ref());
		match self.fs.route(link)? {
			Route::Native => native::symlink(target, link, kind),
			Route::Provider(provider) => self.run(provider.symlink(target, link, kind)),
			Route::Mounted(_) => Err(already_exists()),
		}
	}

	/// Follows symlinks.
	pub fn set_permissions(
		&self,
		path: impl AsRef<Path>,
		permissions: Permissions,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::set_permissions(path, permissions),
			Route::Provider(provider) => self.run(provider.set_permissions(path, permissions)),
			Route::Mounted(file) => file.set_permissions(permissions),
		}
	}

	/// See [`Fs::set_times`].
	pub fn set_times(
		&self,
		path: impl AsRef<Path>,
		accessed: impl Into<FileTime>,
		modified: impl Into<FileTime>,
		follow: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		let (accessed, modified) = (accessed.into(), modified.into());
		match self.fs.route(path)? {
			Route::Native => native::set_times(path, accessed, modified, follow),
			Route::Provider(provider) => {
				self.run(provider.set_times(path, accessed, modified, follow))
			},
			Route::Mounted(file) => file.set_times(accessed, modified),
		}
	}

	pub fn chown(
		&self,
		path: impl AsRef<Path>,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::chown(path, uid, gid, follow),
			Route::Provider(provider) => self.run(provider.chown(path, uid, gid, follow)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// See [`Fs::access`].
	pub fn access(
		&self,
		path: impl AsRef<Path>,
		read: bool,
		write: bool,
		execute: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::access(path, read, write, execute),
			Route::Provider(provider) => self.run(provider.access(path, read, write, execute)),
			Route::Mounted(_) => mount_access(execute),
		}
	}

	/// `Ok(false)` only for `NotFound`; other errors propagate.
	pub fn try_exists(&self, path: impl AsRef<Path>) -> io::Result<bool> {
		not_found_is_false(self.metadata(path))
	}

	/// Follows symlinks; any error is `false`.
	pub fn exists(&self, path: impl AsRef<Path>) -> bool {
		self.metadata(path).is_ok()
	}

	pub fn is_file(&self, path: impl AsRef<Path>) -> bool {
		self.metadata(path).is_ok_and(|metadata| metadata.is_file())
	}

	pub fn is_dir(&self, path: impl AsRef<Path>) -> bool {
		self.metadata(path).is_ok_and(|metadata| metadata.is_dir())
	}

	pub fn is_symlink(&self, path: impl AsRef<Path>) -> bool {
		self
			.symlink_metadata(path)
			.is_ok_and(|metadata| metadata.is_symlink())
	}

	/// See [`Fs::file_id`].
	pub fn file_id(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<FileId> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::file_id(path, follow),
			Route::Provider(_) => self
				.metadata_follow(path, follow)?
				.file_id()
				.ok_or_else(|| unsupported("file identity")),
			Route::Mounted(file) => file
				.metadata()?
				.file_id()
				.ok_or_else(|| unsupported("file identity")),
		}
	}

	/// See [`Fs::same_file`].
	pub fn same_file(&self, a: impl AsRef<Path>, b: impl AsRef<Path>) -> io::Result<bool> {
		identity_result(self.file_id(a, true), self.file_id(b, true))
	}

	pub fn link_count(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<u64> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::link_count(path, follow),
			Route::Provider(_) => self
				.metadata_follow(path, follow)?
				.nlink()
				.ok_or_else(|| unsupported("link count")),
			Route::Mounted(file) => file
				.metadata()?
				.nlink()
				.ok_or_else(|| unsupported("link count")),
		}
	}

	/// See [`Fs::allocated_size`].
	pub fn allocated_size(&self, path: impl AsRef<Path>) -> io::Result<u64> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::allocated_size(path),
			Route::Provider(_) => blocks_to_bytes(&self.metadata(path)?),
			Route::Mounted(file) => blocks_to_bytes(&file.metadata()?),
		}
	}

	pub fn stat_fs(&self, path: impl AsRef<Path>) -> io::Result<StatFs> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::stat_fs(path),
			Route::Provider(provider) => self.run(provider.stat_fs(path)),
			Route::Mounted(file) => mount_stat_fs(file),
		}
	}

	pub fn list_xattr(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<Vec<OsString>> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::list_xattr(path, follow),
			Route::Provider(provider) => self.run(provider.list_xattr(path, follow)),
			Route::Mounted(_) => Err(unsupported("listxattr")),
		}
	}

	/// `Ok(None)` when the attribute is absent.
	pub fn get_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		follow: bool,
	) -> io::Result<Option<Vec<u8>>> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.fs.route(path)? {
			Route::Native => native::get_xattr(path, name, follow),
			Route::Provider(provider) => self.run(provider.get_xattr(path, name, follow)),
			Route::Mounted(_) => Err(unsupported("getxattr")),
		}
	}

	pub fn set_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		value: &[u8],
		follow: bool,
	) -> io::Result<()> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.fs.route(path)? {
			Route::Native => native::set_xattr(path, name, value, follow),
			Route::Provider(provider) => self.run(provider.set_xattr(path, name, value, follow)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub fn remove_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		follow: bool,
	) -> io::Result<()> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.fs.route(path)? {
			Route::Native => native::remove_xattr(path, name, follow),
			Route::Provider(provider) => self.run(provider.remove_xattr(path, name, follow)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// See [`Fs::make_fifo`].
	pub fn make_fifo(&self, path: impl AsRef<Path>, mode: u32) -> io::Result<()> {
		self.make_node(path, NodeKind::Fifo, mode)
	}

	/// See [`Fs::make_node`].
	pub fn make_node(&self, path: impl AsRef<Path>, kind: NodeKind, mode: u32) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native_make_node(&self.fs.scope, path, kind, mode),
			Route::Provider(provider) => self.run(provider.make_node(path, kind, mode)),
			Route::Mounted(_) => Err(already_exists()),
		}
	}
}
