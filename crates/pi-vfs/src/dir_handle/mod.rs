//! Directory handles: a directory opened once, below which every call names
//! one entry.
//!
//! A walk through handles pays one lookup per entry instead of a resolution
//! of the entry's whole path, and it follows no symlink that was swapped in
//! for a directory after the directory was listed.
//!
//! [`Fs::open_dir`] and [`BlockingFs::open_dir`](crate::BlockingFs::open_dir)
//! open a [`DirHandle`]:
//!
//! - On the host it holds a descriptor (Unix) or handle (Windows), and its
//!   calls are syscalls relative to it where implemented (`openat`, `fstatat`,
//!   `unlinkat`, ...; `NtCreateFile` with a root directory on Windows): most
//!   are one call, a listing loops over its reads, a directory open can probe
//!   and stat, a masked creation sets the mode again, and the Windows module
//!   says which calls go through the directory's path there.
//! - On a provider it holds the directory's path and the facade it came from.
//!   Each call joins the entry's name to that path ([`child_path`]) and makes
//!   the facade's call on it, so providers need no extra trait methods; they
//!   keep their per-call path cost, and they cannot hold a call against a
//!   concurrent swap (see the provider notes on each call).
//!
//! Methods come in pairs, as [`File`]'s do: the plain name is synchronous (a
//! provider call is driven to completion on the calling thread, as
//! [`BlockingFs`](crate::BlockingFs) drives it, see the crate docs) and the
//! `_async` twin awaits it. An entry name is one component: an empty name,
//! `.`, `..` and a name holding a separator (`/`; on Windows `\` too) are
//! refused with [`io::ErrorKind::InvalidInput`], and on Windows a name holding
//! `:` too, which would name a drive (`C:x`) or a stream of another entry
//! (`a:s`). [`DirHandle::open_parent`] climbs.
//!
//! Tree walkers (`pi-walker`) use the rest of this module:
//! [`DirHandle::list_into`] reads a listing into a reusable [`Listing`];
//! [`DirHandle::open_regular_at_async`] opens a listed regular file with its
//! [`FileInfo`]; the `*_beneath_async` calls reach a walk-relative path below
//! a walk root's handle, following no symlink on the way; [`host`] has the
//! same reads by absolute host path, for what a walk opens before it holds a
//! handle. Host calls keep their syscall scratch (listing buffer, name
//! buffers) per thread, so steady-state listings and opens allocate nothing.

pub mod host;
mod listing;
mod native;
mod provider;
#[cfg(test)]
mod tests;
#[cfg(any(windows, test))]
mod wtf8;

#[cfg(unix)]
use std::sync::Arc;
use std::{
	borrow::Cow,
	cell::RefCell,
	ffi::OsStr,
	fmt, io,
	path::{Path, PathBuf},
};

use tokio::runtime::Handle;

pub use self::listing::{Detail, FileInfo, FileType, Listing, Record, Stamp};
#[cfg(unix)]
use crate::fs::{FifoEnd, FifoOpening, FifoRelease};
use crate::{
	error::crosses_devices,
	file::File,
	fs::Fs,
	metadata::Metadata,
	options::{DirOptions, OpenOptions},
	path::child_path,
	runtime::{Scope, block_on},
	types::{FileId, FileTime, Permissions},
};

/// Parallelism past which concurrent host listing costs more than it gains:
/// 4 on macOS (APFS contention), 8 on Linux, 4 elsewhere.
pub const WORKERS: usize = native::WORKERS;

/// Scratch kept between threads, so a thread's first host call does not pay
/// for a fresh listing buffer (128 KiB on Linux, allocated and faulted in):
/// a tree walk often runs on threads that did not exist before it.
static POOL: ScratchPool = ScratchPool::new();

/// Most scratch a [`ScratchPool`] keeps.
const MAX_POOLED: usize = 32;

/// Spare syscall scratch, at most [`MAX_POOLED`].
struct ScratchPool(parking_lot::Mutex<Vec<native::Scratch>>);

impl ScratchPool {
	const fn new() -> Self {
		Self(parking_lot::Mutex::new(Vec::new()))
	}

	/// A kept scratch, or a fresh one.
	fn take(&self) -> native::Scratch {
		self.0.lock().pop().unwrap_or_default()
	}

	/// Keeps `scratch` unless the pool is full.
	fn give(&self, scratch: native::Scratch) {
		let mut kept = self.0.lock();
		if kept.len() < MAX_POOLED {
			kept.push(scratch);
		}
	}
}

/// A thread's scratch: taken from its pool on the thread's first host call,
/// given back when the thread ends.
struct Pooled {
	pool:    &'static ScratchPool,
	scratch: Option<native::Scratch>,
}

impl Pooled {
	const fn from(pool: &'static ScratchPool) -> Self {
		Self { pool, scratch: None }
	}

	fn get(&mut self) -> &mut native::Scratch {
		self.scratch.get_or_insert_with(|| self.pool.take())
	}
}

impl Drop for Pooled {
	fn drop(&mut self) {
		if let Some(scratch) = self.scratch.take() {
			self.pool.give(scratch);
		}
	}
}

thread_local! {
	/// The host calls' syscall scratch, one per thread.
	static SCRATCH: RefCell<Pooled> = const { RefCell::new(Pooled::from(&POOL)) };
}

/// Runs `call` with this thread's scratch, or with one of its own from
/// [`POOL`] where the thread's is in use (a call made from inside another's
/// syscall, as a test hook does) or already destroyed (a thread-local
/// destructor).
fn with_scratch<T>(call: impl FnOnce(&mut native::Scratch) -> T) -> T {
	let mut call = Some(call);
	let done = SCRATCH
		.try_with(|cell| {
			let mut scratch = cell.try_borrow_mut().ok()?;
			call.take().map(|call| call(scratch.get()))
		})
		.ok()
		.flatten();
	match (done, call) {
		(Some(done), _) => done,
		(None, Some(call)) => {
			let mut own = Pooled::from(&POOL);
			call(own.get())
		},
		(None, None) => unreachable!("a call that ran returned its result"),
	}
}

/// An open directory. Every `*_at` call names one entry of it.
///
/// On the host: a descriptor (Unix) or handle (Windows), closed on drop. On a
/// provider, or opened with [`Fs::open_dir_by_path`]: the directory's path on
/// its facade.
pub struct DirHandle {
	repr: DirRepr,
}

enum DirRepr {
	/// The facade's scope rides along: the creation mask of [`Fs`]'s host
	/// creations, and the cancellation the files it opens observe.
	Host { handle: native::Handle, scope: Scope },
	/// Boxed, so a handle is as small as the host side (a walk keeps many).
	Provider(Box<Provided>),
}

/// A provider directory: its path, the facade that opened it, and the
/// runtime its synchronous calls are driven on outside any runtime.
struct Provided {
	fs:      Fs,
	runtime: Option<Handle>,
	path:    PathBuf,
}

impl Provided {
	fn child(&self, name: &OsStr) -> PathBuf {
		child_path(&self.path, name)
	}

	fn dir(&self, path: PathBuf) -> DirHandle {
		DirHandle {
			repr: DirRepr::Provider(Box::new(Self {
				fs: self.fs.clone(),
				runtime: self.runtime.clone(),
				path,
			})),
		}
	}
}

impl fmt::Debug for DirHandle {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match &self.repr {
			DirRepr::Host { handle, .. } => f.debug_tuple("DirHandle::Host").field(handle).finish(),
			DirRepr::Provider(provided) => f
				.debug_tuple("DirHandle::Provider")
				.field(&provided.path)
				.finish(),
		}
	}
}

/// `name`'s bytes when it is one entry name: not empty, `.` or `..`, holding
/// no separator, and on Windows no `:`, which would make the name a drive's
/// current directory (`C:x`, which a join to a directory's path turns into
/// that) or a stream of another entry (`a:s`, `x::$INDEX_ALLOCATION`).
fn entry_name(name: &OsStr) -> io::Result<&[u8]> {
	let bytes = name.as_encoded_bytes();
	let refused = matches!(bytes, b"" | b"." | b"..")
		|| bytes
			.iter()
			.any(|&b| is_rel_separator(b) || (cfg!(windows) && b == b':'));
	if refused {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a single entry name"));
	}
	Ok(bytes)
}

/// Refuses `O_DIRECTORY` in an open's custom flags: a directory opens only
/// through [`DirHandle::open_dir_at`], which refuses a symlink also on a
/// kernel that follows one despite `O_NOFOLLOW` when `O_DIRECTORY` is set, and
/// on a path handle, the facade's open would open the directory. (Windows
/// custom flags have no such flag.)
#[cfg(unix)]
fn refuse_directory_flag(options: &OpenOptions) -> io::Result<()> {
	if options.get_custom_flags() & libc::O_DIRECTORY != 0 {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"open_at opens no directory: open it with open_dir_at",
		));
	}
	Ok(())
}

/// Refuses a path that is not walk-relative: empty, or with an empty, `.`, or
/// `..` component, each of which would reach something other than an entry a
/// walk listed below its root.
fn check_relative(rel: &[u8]) -> io::Result<()> {
	if rel
		.split(|&b| is_rel_separator(b))
		.any(|part| matches!(part, b"" | b"." | b".."))
	{
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a walk-relative path"));
	}
	Ok(())
}

/// Whether `byte` separates the components of a walk-relative path.
///
/// That is `/`, and on Windows also `\`, which no listed name contains there
/// and which the NT namespace would otherwise resolve inside one component.
/// A caller that splits a walk-relative path before passing its parts to a
/// `beneath` call splits it here, so both agree on its components.
pub const fn is_rel_separator(byte: u8) -> bool {
	byte == b'/' || (cfg!(windows) && byte == b'\\')
}

/// `bytes` (raw `OsStr` encoded bytes: exact on Unix, WTF-8 on Windows, as
/// [`Listing`] names are) as an [`OsStr`]. On Windows `/` becomes `\`.
#[cfg(unix)]
pub fn os_name(bytes: &[u8]) -> Cow<'_, OsStr> {
	use std::os::unix::ffi::OsStrExt;
	Cow::Borrowed(OsStr::from_bytes(bytes))
}

/// `bytes` (raw `OsStr` encoded bytes: exact on Unix, WTF-8 on Windows, as
/// [`Listing`] names are) as an [`OsStr`]. On Windows `/` becomes `\`.
#[cfg(windows)]
pub fn os_name(bytes: &[u8]) -> Cow<'_, OsStr> {
	use std::os::windows::ffi::OsStringExt;
	if let Ok(name) = std::str::from_utf8(bytes)
		&& !name.contains('/')
	{
		return Cow::Borrowed(OsStr::new(name));
	}
	let mut wide = Vec::with_capacity(bytes.len());
	wtf8::push_wide(&mut wide, bytes);
	Cow::Owned(std::ffi::OsString::from_wide(&wide))
}

/// Marker error behind [`is_not_regular`].
#[derive(Debug)]
struct NotRegular;

impl fmt::Display for NotRegular {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("not a regular file")
	}
}

impl std::error::Error for NotRegular {}

/// The error a walk's open of a regular file gives a directory or special
/// file, which [`is_not_regular`] recognizes.
pub fn not_regular() -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, NotRegular)
}

/// Whether `err` is the error [`DirHandle::open_regular_at_async`],
/// [`DirHandle::open_regular_beneath_async`] and [`host::open_regular`]
/// return for directories and special files.
pub fn is_not_regular(err: &io::Error) -> bool {
	err.get_ref().is_some_and(|inner| inner.is::<NotRegular>())
}

/// Marker error behind a provider's refusal of a final symlink, which
/// [`is_symlink_refusal`] recognizes.
#[derive(Debug)]
struct SymlinkRefused;

impl fmt::Display for SymlinkRefused {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("refusing to follow a symbolic link")
	}
}

impl std::error::Error for SymlinkRefused {}

/// The error for an open that does not follow a symlink it found.
pub(crate) fn symlink_refused() -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, SymlinkRefused)
}

/// Whether `err` is an open's refusal of a symlink it did not follow.
///
/// That is `ELOOP` on Unix, `ERROR_STOPPED_ON_SYMLINK` on Windows, or a
/// provider's refusal of a final symlink. From
/// [`DirHandle::open_regular_beneath_async`] the symlink may be the file or a
/// directory on the way; opening the file's directory below the same root
/// tells the two apart.
pub fn is_symlink_refusal(err: &io::Error) -> bool {
	#[cfg(unix)]
	let code = Some(libc::ELOOP);
	#[cfg(windows)]
	let code = Some(windows_sys::Win32::Foundation::ERROR_STOPPED_ON_SYMLINK as i32);
	#[cfg(not(any(unix, windows)))]
	let code = None;
	(code.is_some() && err.raw_os_error() == code)
		|| err
			.get_ref()
			.is_some_and(|inner| inner.is::<SymlinkRefused>())
}

/// A regular file a walk opened for reading, with
/// [`DirHandle::open_regular_at_async`],
/// [`DirHandle::open_regular_beneath_async`] or [`host::open_regular`].
#[derive(Debug)]
pub enum RegularFile {
	/// A host file, read at offsets.
	Host(HostFile),
	/// A file opened through a facade (a provider's file).
	Vfs(File),
}

/// An open host regular file, closed on drop. Its reads take an offset and
/// move no cursor, so readers keep their own position.
#[derive(Debug)]
pub struct HostFile(native::Handle);

impl HostFile {
	/// Reads into `buf` at file offset `offset`; returns the count (0 at end
	/// of file).
	///
	/// # Errors
	///
	/// The read's errors.
	pub fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
		native::read_at(&self.0, buf, offset)
	}

	/// Appends the file's bytes at offset `buf.len()` into `buf`'s spare
	/// capacity, up to length `end`; returns the count read (0 at end of
	/// file). Nothing is written to the spare capacity before the read.
	///
	/// # Errors
	///
	/// The read's errors.
	pub fn read_append(&self, buf: &mut Vec<u8>, end: usize) -> io::Result<usize> {
		native::read_append(&self.0, buf, end)
	}

	/// The open file's metadata, read from the handle rather than from the
	/// path it was opened by: a name replaced after the open still reports
	/// the file that was opened.
	///
	/// # Errors
	///
	/// The handle's status query.
	pub fn metadata(&self) -> io::Result<Metadata> {
		native::handle_metadata(&self.0)
	}

	/// The open file as a [`std::fs::File`] (no reopen), reading from its
	/// start.
	pub fn into_std(self) -> std::fs::File {
		std::fs::File::from(self.0)
	}
}

/// The ways the paired methods below reach their entry.
impl DirHandle {
	/// Opens the host directory at `path` for a facade with `scope`.
	pub(crate) fn open_host(path: &Path, follow: bool, scope: &Scope) -> io::Result<Self> {
		let handle = with_scratch(|s| {
			if follow {
				native::open_dir(s, path)
			} else {
				native::open_dir_unlinked(s, path)
			}
		})?;
		Ok(Self { repr: DirRepr::Host { handle, scope: scope.clone() } })
	}

	/// Opens the provider directory at `path` on `fs`, checking that it is
	/// one (without following a final symlink unless `follow`).
	pub(crate) async fn open_provider(
		fs: &Fs,
		runtime: Option<Handle>,
		path: &Path,
		follow: bool,
	) -> io::Result<Self> {
		provider::open_dir(fs, path, follow).await?;
		Ok(Self {
			repr: DirRepr::Provider(Box::new(Provided {
				fs: fs.clone(),
				runtime,
				path: path.to_path_buf(),
			})),
		})
	}

	/// Runs a synchronous call: `host` on a host handle; on a provider the
	/// future `provider` makes, driven to completion on this thread.
	fn call<'a, T, F>(
		&'a self,
		host: impl FnOnce(&mut native::Scratch, &native::Handle, &Scope) -> io::Result<T>,
		provider: impl FnOnce(&'a Provided) -> F,
	) -> io::Result<T>
	where
		F: Future<Output = io::Result<T>>,
	{
		match &self.repr {
			DirRepr::Host { handle, scope } => with_scratch(|s| host(s, handle, scope)),
			DirRepr::Provider(provided) => block_on(provided.runtime.as_ref(), provider(provided)),
		}
	}

	/// [`Self::call`] for async callers: the provider's future is awaited.
	async fn call_async<'a, T, F>(
		&'a self,
		host: impl FnOnce(&mut native::Scratch, &native::Handle, &Scope) -> io::Result<T>,
		provider: impl FnOnce(&'a Provided) -> F,
	) -> io::Result<T>
	where
		F: Future<Output = io::Result<T>>,
	{
		match &self.repr {
			DirRepr::Host { handle, scope } => with_scratch(|s| host(s, handle, scope)),
			DirRepr::Provider(provided) => provider(provided).await,
		}
	}
}

/// The host side of [`DirHandle::open_dir_at`].
fn host_open_dir_at(
	s: &mut native::Scratch,
	handle: &native::Handle,
	scope: &Scope,
	name: &[u8],
) -> io::Result<DirHandle> {
	let handle = native::open_child(s, handle, name)?;
	Ok(DirHandle { repr: DirRepr::Host { handle, scope: scope.clone() } })
}

/// The provider side of [`DirHandle::open_dir_at`]: the entry is checked to
/// be a directory without following a symlink there.
async fn provider_open_dir_at(provided: &Provided, name: &OsStr) -> io::Result<DirHandle> {
	let path = provided.child(name);
	provider::open_dir(&provided.fs, &path, false).await?;
	Ok(provided.dir(path))
}

/// The host side of [`DirHandle::open_at`] for blocking callers: the file is
/// bound to the facade's scope, as its host opens bind theirs, so its reads
/// observe the scope's cancellation. Under a cancellable scope on Unix, a
/// FIFO's wait for its other end observes the token too
/// ([`host_fifo_end`]).
fn host_open_at(
	s: &mut native::Scratch,
	handle: &native::Handle,
	scope: &Scope,
	name: &[u8],
	options: &OpenOptions,
) -> io::Result<File> {
	#[cfg(unix)]
	if let Some(token) = &scope.cancel
		&& let Some(end) = host_fifo_end(s, handle, name, options)
	{
		let file = host_fifo_open(handle, scope, name, options, end, token)?.wait(token)?;
		return Ok(file.bind_host(token.clone(), true));
	}
	open_host_entry(s, handle, scope, name, options)
}

/// The host side of [`DirHandle::open_at_async`]. On Unix a FIFO's wait for
/// its other end runs on a helper thread and is awaited, so it never holds
/// the runtime worker that end may need (a task of the same runtime), and
/// it observes the scope's token.
#[cfg_attr(
	not(unix),
	allow(clippy::unused_async, reason = "the FIFO wait is awaited only on Unix")
)]
async fn host_open_at_async(
	handle: &native::Handle,
	scope: &Scope,
	name: &[u8],
	options: &OpenOptions,
) -> io::Result<File> {
	#[cfg(unix)]
	if let Some(end) = with_scratch(|s| host_fifo_end(s, handle, name, options)) {
		let token = scope.cancel.clone().unwrap_or_default();
		let file = host_fifo_open(handle, scope, name, options, end, &token)?
			.wait_async(&token)
			.await?;
		return Ok(if scope.cancel.is_some() {
			file.bind_host(token, true)
		} else {
			file
		});
	}
	with_scratch(|s| open_host_entry(s, handle, scope, name, options))
}

/// Opens `name` in `handle` under `scope`'s creation mask, the file bound
/// to the scope.
fn open_host_entry(
	s: &mut native::Scratch,
	handle: &native::Handle,
	scope: &Scope,
	name: &[u8],
	options: &OpenOptions,
) -> io::Result<File> {
	let file = native::open_at(s, handle, name, options, host_mask(scope))?;
	Ok(File::from(file).bind(scope))
}

/// The end of a FIFO an `open_at` of `name` with `options` waits on: when
/// the open can block (read-only or write-only, without `O_NONBLOCK`, not
/// creating the entry new) and `name` is a FIFO, by one `fstatat` that does
/// not follow a symlink there (the open refuses one anyway). If the entry
/// changes between the `fstatat` and the open, it is opened as the
/// `fstatat` described it, as the facade's opens are.
#[cfg(unix)]
fn host_fifo_end(
	s: &mut native::Scratch,
	handle: &native::Handle,
	name: &[u8],
	options: &OpenOptions,
) -> Option<FifoEnd> {
	if options.is_create_new() || options.get_custom_flags() & libc::O_NONBLOCK != 0 {
		return None;
	}
	let end = match (options.is_read(), options.is_writable()) {
		(true, false) if !options.is_create() => FifoEnd::Read,
		(false, true) => FifoEnd::Write,
		_ => return None,
	};
	let meta = native::stat_at(s, handle, name, false).ok()?;
	meta.file_type().is_fifo().then_some(end)
}

/// Starts the open of `end` of the FIFO `name` in `handle` on a helper
/// thread ([`FifoOpening`]), through a duplicate of the directory's
/// descriptor; a cancelled or dropped open is released by a non-blocking
/// open of the other end relative to the same directory.
#[cfg(unix)]
fn host_fifo_open(
	handle: &native::Handle,
	scope: &Scope,
	name: &[u8],
	options: &OpenOptions,
	end: FifoEnd,
	token: &tokio_util::sync::CancellationToken,
) -> io::Result<FifoOpening> {
	let dir = Arc::new(handle.try_clone()?);
	let releasable = native::may_access_at(handle, name, end.release_access());
	let (open_dir, open_name, options, mask) =
		(Arc::clone(&dir), name.to_vec(), options.clone(), host_mask(scope));
	let (release_name, writer) = (name.to_vec(), end.released_by_writer());
	let release: FifoRelease = Arc::new(move || {
		native::touch_fifo_at(&dir, &release_name, writer).map(|end| Box::new(end) as Box<dyn Send>)
	});
	FifoOpening::spawn(
		move || {
			with_scratch(|s| native::open_at(s, &open_dir, &open_name, &options, mask)).map(File::from)
		},
		release,
		releasable,
		token,
	)
}

const fn provider_dir_options(mode: Option<u32>) -> DirOptions {
	let mut options = DirOptions::new();
	if let Some(mode) = mode {
		options = options.mode(mode);
	}
	options
}

/// Both handles of a rename, which must live on one side.
enum RenamePair<'a> {
	Host(&'a native::Handle, &'a native::Handle),
	Provider(&'a Provided, &'a Provided),
}

impl DirHandle {
	fn rename_pair<'a>(&'a self, to_dir: &'a Self) -> io::Result<RenamePair<'a>> {
		match (&self.repr, &to_dir.repr) {
			(DirRepr::Host { handle, .. }, DirRepr::Host { handle: to, .. }) => {
				Ok(RenamePair::Host(handle, to))
			},
			(DirRepr::Provider(from), DirRepr::Provider(to)) if from.fs.ptr_eq(&to.fs) => {
				Ok(RenamePair::Provider(from, to))
			},
			_ => Err(crosses_devices()),
		}
	}
}

/// The general calls. Each names one entry of the directory.
impl DirHandle {
	/// Whether this handle holds a host descriptor or handle, as opposed to a
	/// path on its facade.
	pub const fn is_native(&self) -> bool {
		matches!(self.repr, DirRepr::Host { .. })
	}

	/// Opens the subdirectory `name`, never through a symlink: one there is
	/// refused (`ENOTDIR` on Unix, also on a kernel that follows it despite
	/// `O_NOFOLLOW`; a reparse point is opened itself on Windows, and
	/// listings report it as a symlink), also when it replaced the directory
	/// after a listing. A provider checks the entry with `symlink_metadata`
	/// and so refuses a symlink that is there when checked.
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the open's errors; an entry that
	/// is not a directory.
	pub fn open_dir_at(&self, name: &OsStr) -> io::Result<Self> {
		let bytes = entry_name(name)?;
		self.call(
			|s, handle, scope| host_open_dir_at(s, handle, scope, bytes),
			|provided| provider_open_dir_at(provided, name),
		)
	}

	/// Async [`Self::open_dir_at`].
	///
	/// # Errors
	///
	/// As for [`Self::open_dir_at`].
	pub async fn open_dir_at_async(&self, name: &OsStr) -> io::Result<Self> {
		let bytes = entry_name(name)?;
		self
			.call_async(
				|s, handle, scope| host_open_dir_at(s, handle, scope, bytes),
				|provided| provider_open_dir_at(provided, name),
			)
			.await
	}

	/// Opens the directory `..` of this one, which is its parent only while
	/// this directory has not moved: callers check the identity of what they
	/// get ([`Self::identity`]).
	///
	/// # Errors
	///
	/// [`io::ErrorKind::Unsupported`] where `..` cannot be opened relative to
	/// a handle (Windows, whose relative names do not climb, and providers);
	/// the open's errors.
	pub fn open_parent(&self) -> io::Result<Self> {
		match &self.repr {
			DirRepr::Host { handle, scope } => {
				let handle = with_scratch(|s| native::open_parent(s, handle))?;
				Ok(Self { repr: DirRepr::Host { handle, scope: scope.clone() } })
			},
			DirRepr::Provider(_) => Err(io::ErrorKind::Unsupported.into()),
		}
	}

	/// The identity of this directory: device and inode on Unix, volume
	/// serial and file index on Windows, the provider's own ids otherwise
	/// (followed through a symlink the provider path names).
	///
	/// # Errors
	///
	/// The status query's errors; [`io::ErrorKind::Unsupported`] for a
	/// provider that reports no identity.
	pub fn identity(&self) -> io::Result<FileId> {
		self.call(
			|_, handle, _| native::identify_dir(handle),
			|provided| provided.fs.file_id(&provided.path, true),
		)
	}

	/// Async [`Self::identity`].
	///
	/// # Errors
	///
	/// As for [`Self::identity`].
	pub async fn identity_async(&self) -> io::Result<FileId> {
		self
			.call_async(
				|_, handle, _| native::identify_dir(handle),
				|provided| provided.fs.file_id(&provided.path, true),
			)
			.await
	}

	/// Lists every entry of this directory into `out` (cleared first), except
	/// `.` and `..`, skipping special files and entries that vanish between
	/// the listing and their metadata lookup. `children` is the entry count
	/// from the parent's listing (0 when unknown); readers may use it to end
	/// early. A host handle reads from its current position (no rewind
	/// syscall), so list each handle once; open it again to list it again.
	///
	/// # Errors
	///
	/// The listing's errors. A provider listing refuses a name that is not a
	/// single path component with [`io::ErrorKind::InvalidData`].
	pub fn list_into(&self, detail: Detail, children: u32, out: &mut Listing) -> io::Result<()> {
		out.clear();
		match &self.repr {
			DirRepr::Host { handle, .. } => {
				with_scratch(|s| native::list(s, handle, detail, children, out))
			},
			DirRepr::Provider(provided) => block_on(
				provided.runtime.as_ref(),
				provider::list(&provided.fs, &provided.path, detail, out),
			),
		}
	}

	/// Async [`Self::list_into`].
	///
	/// # Errors
	///
	/// As for [`Self::list_into`].
	pub async fn list_into_async(
		&self,
		detail: Detail,
		children: u32,
		out: &mut Listing,
	) -> io::Result<()> {
		out.clear();
		match &self.repr {
			DirRepr::Host { handle, .. } => {
				with_scratch(|s| native::list(s, handle, detail, children, out))
			},
			DirRepr::Provider(provided) => {
				provider::list(&provided.fs, &provided.path, detail, out).await
			},
		}
	}

	/// Describes the entry `name`, following a symlink there only with
	/// `follow`. Host metadata comes from `fstatat` (carrying host identity,
	/// but no [`std::fs::Metadata`]: [`Metadata::native`] is `None`); on
	/// Windows it is the facades' path stat.
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the stat's errors.
	pub fn stat_at(&self, name: &OsStr, follow: bool) -> io::Result<Metadata> {
		let bytes = entry_name(name)?;
		self.call(
			|s, handle, _| native::stat_at(s, handle, bytes, follow),
			|provided| provider_stat_at(provided, name, follow),
		)
	}

	/// Async [`Self::stat_at`].
	///
	/// # Errors
	///
	/// As for [`Self::stat_at`].
	pub async fn stat_at_async(&self, name: &OsStr, follow: bool) -> io::Result<Metadata> {
		let bytes = entry_name(name)?;
		self
			.call_async(
				|s, handle, _| native::stat_at(s, handle, bytes, follow),
				|provided| provider_stat_at(provided, name, follow),
			)
			.await
	}

	/// Opens the entry `name` as `options` say, never through a symlink
	/// there: `ELOOP` on Unix, `ERROR_STOPPED_ON_SYMLINK` on Windows, and on a
	/// provider [`is_symlink_refusal`]'s error for one there when checked. No
	/// directory: `O_DIRECTORY` is refused, as [`Self::open_dir_at`] opens
	/// one. A file it creates gets the mode `options` give (`0o666` by
	/// default) as the facade's host opens give it: less the process umask,
	/// or exactly less the facade's creation mask. The file's reads observe
	/// the facade's cancellation, as files opened through the facade do.
	///
	/// A FIFO's open waits for its other end. On the host on Unix,
	/// [`Self::open_at_async`] waits on a helper thread, holding no runtime
	/// worker, and this call waits on the calling thread; both observe a
	/// cancellable facade's token, as the facade's own opens do.
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the refusal of a symlink;
	/// [`io::ErrorKind::InvalidInput`] for `O_DIRECTORY`; the open's errors,
	/// `EINVAL` for options [`std::fs::OpenOptions`] refuses included; the
	/// facade's cancellation error once its token fires during a FIFO's
	/// wait.
	pub fn open_at(&self, name: &OsStr, options: &OpenOptions) -> io::Result<File> {
		let bytes = entry_name(name)?;
		#[cfg(unix)]
		refuse_directory_flag(options)?;
		self.call(
			|s, handle, scope| host_open_at(s, handle, scope, bytes, options),
			|provided| provider_open_at(provided, name, options),
		)
	}

	/// Async [`Self::open_at`].
	///
	/// # Errors
	///
	/// As for [`Self::open_at`].
	pub async fn open_at_async(&self, name: &OsStr, options: &OpenOptions) -> io::Result<File> {
		let bytes = entry_name(name)?;
		#[cfg(unix)]
		refuse_directory_flag(options)?;
		match &self.repr {
			DirRepr::Host { handle, scope } => host_open_at_async(handle, scope, bytes, options).await,
			DirRepr::Provider(provided) => provider_open_at(provided, name, options).await,
		}
	}

	/// Creates the directory `name` with `mode` (`0o777` by default) as the
	/// facade's creations give it: less the process umask, or exactly less
	/// the facade's creation mask.
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the creation's errors (an entry
	/// that exists already included).
	pub fn create_dir_at(&self, name: &OsStr, mode: Option<u32>) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self.call(
			|s, handle, scope| native::create_dir_at(s, handle, bytes, mode, host_mask(scope)),
			|provided| provider_create_dir_at(provided, name, mode),
		)
	}

	/// Async [`Self::create_dir_at`].
	///
	/// # Errors
	///
	/// As for [`Self::create_dir_at`].
	pub async fn create_dir_at_async(&self, name: &OsStr, mode: Option<u32>) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self
			.call_async(
				|s, handle, scope| native::create_dir_at(s, handle, bytes, mode, host_mask(scope)),
				|provided| provider_create_dir_at(provided, name, mode),
			)
			.await
	}

	/// Removes the entry `name`: an empty directory with `dir`, else a file, a
	/// symlink (itself) or a special file. On Windows a directory symlink or
	/// junction counts as a directory, as [`std::fs::remove_dir`] removes it
	/// there.
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the removal's errors.
	pub fn remove_at(&self, name: &OsStr, dir: bool) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self.call(
			|s, handle, _| native::remove_at(s, handle, bytes, dir),
			|provided| provider_remove_at(provided, name, dir),
		)
	}

	/// Async [`Self::remove_at`].
	///
	/// # Errors
	///
	/// As for [`Self::remove_at`].
	pub async fn remove_at_async(&self, name: &OsStr, dir: bool) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self
			.call_async(
				|s, handle, _| native::remove_at(s, handle, bytes, dir),
				|provided| provider_remove_at(provided, name, dir),
			)
			.await
	}

	/// Renames the entry `from` to the entry `to` of `to_dir`, replacing what
	/// `rename(2)` replaces. Both handles must be host handles, or both path
	/// handles on one facade ([`Fs::ptr_eq`]): the rename is one call of that
	/// facade, which resolves both paths.
	///
	/// # Errors
	///
	/// A name that is not one entry name; [`crate::crosses_devices`] for one
	/// host and one path handle, or path handles on two facades; the rename's
	/// errors.
	pub fn rename_at(&self, from: &OsStr, to_dir: &Self, to: &OsStr) -> io::Result<()> {
		let (from_bytes, to_bytes) = (entry_name(from)?, entry_name(to)?);
		match self.rename_pair(to_dir)? {
			RenamePair::Host(handle, to_handle) => {
				with_scratch(|s| native::rename_at(s, handle, from_bytes, to_handle, to_bytes))
			},
			RenamePair::Provider(provided, to_provided) => block_on(
				provided.runtime.as_ref(),
				provided
					.fs
					.rename(provided.child(from), to_provided.child(to)),
			),
		}
	}

	/// Async [`Self::rename_at`].
	///
	/// # Errors
	///
	/// As for [`Self::rename_at`].
	pub async fn rename_at_async(&self, from: &OsStr, to_dir: &Self, to: &OsStr) -> io::Result<()> {
		let (from_bytes, to_bytes) = (entry_name(from)?, entry_name(to)?);
		match self.rename_pair(to_dir)? {
			RenamePair::Host(handle, to_handle) => {
				with_scratch(|s| native::rename_at(s, handle, from_bytes, to_handle, to_bytes))
			},
			RenamePair::Provider(provided, to_provided) => {
				provided
					.fs
					.rename(provided.child(from), to_provided.child(to))
					.await
			},
		}
	}

	/// Makes the entry `name` a symlink holding `target` verbatim.
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the creation's errors.
	pub fn symlink_at(&self, target: &Path, name: &OsStr) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self.call(
			|s, handle, _| native::symlink_at(s, handle, target, bytes),
			|provided| provided.fs.symlink(target, provided.child(name)),
		)
	}

	/// Async [`Self::symlink_at`].
	///
	/// # Errors
	///
	/// As for [`Self::symlink_at`].
	pub async fn symlink_at_async(&self, target: &Path, name: &OsStr) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self
			.call_async(
				|s, handle, _| native::symlink_at(s, handle, target, bytes),
				|provided| provided.fs.symlink(target, provided.child(name)),
			)
			.await
	}

	/// The target the symlink `name` holds.
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the read's errors (`EINVAL` for an
	/// entry that is no symlink).
	pub fn read_link_at(&self, name: &OsStr) -> io::Result<PathBuf> {
		let bytes = entry_name(name)?;
		self.call(
			|s, handle, _| native::read_link_at(s, handle, bytes),
			|provided| provided.fs.read_link(provided.child(name)),
		)
	}

	/// Async [`Self::read_link_at`].
	///
	/// # Errors
	///
	/// As for [`Self::read_link_at`].
	pub async fn read_link_at_async(&self, name: &OsStr) -> io::Result<PathBuf> {
		let bytes = entry_name(name)?;
		self
			.call_async(
				|s, handle, _| native::read_link_at(s, handle, bytes),
				|provided| provided.fs.read_link(provided.child(name)),
			)
			.await
	}

	/// Sets the permissions of the entry `name`, following a symlink there
	/// only with `follow`. Without, a symlink there is not changed: Linux
	/// refuses it (`EOPNOTSUPP`), macOS changes the link itself, and Windows
	/// and providers refuse it.
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the change's errors.
	pub fn set_permissions_at(
		&self,
		name: &OsStr,
		permissions: Permissions,
		follow: bool,
	) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self.call(
			|s, handle, _| native::set_permissions_at(s, handle, bytes, permissions, follow),
			|provided| provider_set_permissions_at(provided, name, permissions, follow),
		)
	}

	/// Async [`Self::set_permissions_at`].
	///
	/// # Errors
	///
	/// As for [`Self::set_permissions_at`].
	pub async fn set_permissions_at_async(
		&self,
		name: &OsStr,
		permissions: Permissions,
		follow: bool,
	) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self
			.call_async(
				|s, handle, _| native::set_permissions_at(s, handle, bytes, permissions, follow),
				|provided| provider_set_permissions_at(provided, name, permissions, follow),
			)
			.await
	}

	/// Sets the access and modification times of the entry `name`:
	/// [`FileTime::Omit`] keeps a time, [`FileTime::Now`] takes the
	/// filesystem clock; without `follow` a symlink there gets the times
	/// itself.
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the change's errors.
	pub fn set_times_at(
		&self,
		name: &OsStr,
		accessed: FileTime,
		modified: FileTime,
		follow: bool,
	) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self.call(
			|s, handle, _| native::set_times_at(s, handle, bytes, accessed, modified, follow),
			|provided| {
				provided
					.fs
					.set_times(provided.child(name), accessed, modified, follow)
			},
		)
	}

	/// Async [`Self::set_times_at`].
	///
	/// # Errors
	///
	/// As for [`Self::set_times_at`].
	pub async fn set_times_at_async(
		&self,
		name: &OsStr,
		accessed: FileTime,
		modified: FileTime,
		follow: bool,
	) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self
			.call_async(
				|s, handle, _| native::set_times_at(s, handle, bytes, accessed, modified, follow),
				|provided| {
					provided
						.fs
						.set_times(provided.child(name), accessed, modified, follow)
				},
			)
			.await
	}

	/// Changes the owner and group of the entry `name` (`None` keeps that
	/// id); without `follow` a symlink there changes owner itself.
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the change's errors.
	pub fn chown_at(
		&self,
		name: &OsStr,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self.call(
			|s, handle, _| native::chown_at(s, handle, bytes, uid, gid, follow),
			|provided| provided.fs.chown(provided.child(name), uid, gid, follow),
		)
	}

	/// Async [`Self::chown_at`].
	///
	/// # Errors
	///
	/// As for [`Self::chown_at`].
	pub async fn chown_at_async(
		&self,
		name: &OsStr,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		let bytes = entry_name(name)?;
		self
			.call_async(
				|s, handle, _| native::chown_at(s, handle, bytes, uid, gid, follow),
				|provided| provided.fs.chown(provided.child(name), uid, gid, follow),
			)
			.await
	}
}

/// The facade's creation mask where it applies: Unix host creations.
fn host_mask(scope: &Scope) -> Option<u32> {
	scope.creation_mask.filter(|_| cfg!(unix))
}

async fn provider_set_permissions_at(
	provided: &Provided,
	name: &OsStr,
	permissions: Permissions,
	follow: bool,
) -> io::Result<()> {
	provider::set_permissions(&provided.fs, &provided.child(name), permissions, follow).await
}

async fn provider_stat_at(provided: &Provided, name: &OsStr, follow: bool) -> io::Result<Metadata> {
	let path = provided.child(name);
	if follow {
		provided.fs.metadata(path).await
	} else {
		provided.fs.symlink_metadata(path).await
	}
}

async fn provider_open_at(
	provided: &Provided,
	name: &OsStr,
	options: &OpenOptions,
) -> io::Result<File> {
	provider::open_at(&provided.fs, &provided.child(name), options).await
}

async fn provider_create_dir_at(
	provided: &Provided,
	name: &OsStr,
	mode: Option<u32>,
) -> io::Result<()> {
	provided
		.fs
		.create_dir_with(provided.child(name), &provider_dir_options(mode))
		.await
}

async fn provider_remove_at(provided: &Provided, name: &OsStr, dir: bool) -> io::Result<()> {
	provider::remove(&provided.fs, &provided.child(name), dir).await
}

/// The walk calls: what a tree walker reads and writes below a directory it
/// listed.
impl DirHandle {
	/// Opens the regular file `name` and describes it. With `follow`, a
	/// symlink there is followed, as an open by path follows it. Without, a
	/// symlink there is refused (`ELOOP` on Unix, `ERROR_STOPPED_ON_SYMLINK`
	/// for any reparse point on Windows): a walk that does not follow
	/// symlinks reads the file it listed or nothing, also when the name was
	/// replaced by a symlink since the listing. FIFOs never block the open.
	/// Providers check the name and then open it, see
	/// [`Self::open_regular_beneath_async`].
	///
	/// # Errors
	///
	/// A `name` that is not one entry name; the refusal of a symlink;
	/// [`is_not_regular`] for directories and special files; the open's
	/// errors.
	pub async fn open_regular_at_async(
		&self,
		name: &OsStr,
		follow: bool,
	) -> io::Result<(RegularFile, FileInfo)> {
		let bytes = entry_name(name)?;
		match &self.repr {
			DirRepr::Host { handle, .. } => {
				let (handle, info) = with_scratch(|s| native::open_file_at(s, handle, bytes, follow))?;
				Ok((RegularFile::Host(HostFile(handle)), info))
			},
			DirRepr::Provider(provided) => {
				let path = provided.child(name);
				let (file, info) = if follow {
					provider::open_file(&provided.fs, &path).await?
				} else {
					provider::open_file_unlinked(&provided.fs, &path).await?
				};
				Ok((RegularFile::Vfs(file), info))
			},
		}
	}

	/// Opens the regular file at the walk-relative `rel` (`/`-separated raw
	/// names, none of them empty, `.`, or `..`; on Windows `\` separates them
	/// too) below this directory, following no symlink on the way: neither
	/// the file nor any directory between this one and it, also one swapped
	/// in since the listing. This is how a walk that does not follow symlinks
	/// opens a file whose listing carries no directory handle.
	///
	/// Host opens resolve below the handle, never by path: on Linux one
	/// `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` where the
	/// kernel has it; elsewhere, and where it does not, one component at a
	/// time relative to the directory before it (`O_NOFOLLOW`; on Windows
	/// `FILE_OPEN_REPARSE_POINT`), holding at most two handles at once. A
	/// symlink on the way fails the open (`ELOOP` or `ENOTDIR` on Unix,
	/// `ERROR_STOPPED_ON_SYMLINK` for any reparse point on Windows).
	///
	/// Providers resolve paths themselves, so they cannot hold this against a
	/// concurrent swap: the open checks the final component with
	/// `symlink_metadata` and refuses a symlink, then opens the path, and the
	/// provider resolves the directories on the way. A symlink swapped in
	/// between the check and the open, or for one of those directories, is
	/// followed.
	///
	/// # Errors
	///
	/// [`io::ErrorKind::InvalidInput`] for a `rel` that is not walk-relative,
	/// the refusal of a symlink, [`is_not_regular`] for directories and
	/// special files, and the open's own errors.
	pub async fn open_regular_beneath_async(
		&self,
		rel: &[u8],
	) -> io::Result<(RegularFile, FileInfo)> {
		check_relative(rel)?;
		match &self.repr {
			DirRepr::Host { handle, .. } => {
				let (handle, info) = with_scratch(|s| native::open_file_beneath(s, handle, rel))?;
				Ok((RegularFile::Host(HostFile(handle)), info))
			},
			DirRepr::Provider(provided) => {
				let (file, info) =
					provider::open_file_unlinked(&provided.fs, &provider::beneath(&provided.path, rel))
						.await?;
				Ok((RegularFile::Vfs(file), info))
			},
		}
	}

	/// Opens the directory at the walk-relative `rel` below this directory,
	/// following no symlink on the way, as
	/// [`Self::open_regular_beneath_async`] opens a file (with the same
	/// provider limits). This is how a walk that does not follow symlinks
	/// opens a directory whose parent's listing carries no handle.
	///
	/// # Errors
	///
	/// As for [`Self::open_regular_beneath_async`]; a `rel` that is not a
	/// directory fails like [`Self::open_dir_at`].
	pub async fn open_dir_beneath_async(&self, rel: &[u8]) -> io::Result<Self> {
		check_relative(rel)?;
		match &self.repr {
			DirRepr::Host { handle, scope } => {
				let handle = with_scratch(|s| native::open_dir_beneath(s, handle, rel))?;
				Ok(Self { repr: DirRepr::Host { handle, scope: scope.clone() } })
			},
			DirRepr::Provider(provided) => {
				let path = provider::beneath(&provided.path, rel);
				provider::open_dir(&provided.fs, &path, false).await?;
				Ok(provided.dir(path))
			},
		}
	}

	/// Replaces the contents of the regular file at the walk-relative `rel`
	/// below this directory with `contents`, creating the file when it is
	/// missing, and follows no symlink on the way or at the file: the write
	/// lands on a file below this directory or nowhere, also when a directory
	/// on the way or the file itself was replaced by a symlink since the
	/// listing. This is how a walk that does not follow symlinks writes back
	/// a file it listed.
	///
	/// The file is rewritten in place, as [`std::fs::write`] and
	/// [`Fs::write`] rewrite it: one open, truncated, then written, so its
	/// identity, permissions, owner, and hard links stay, and a new file gets
	/// mode `0o666` less the umask. Host writes open the file's directory as
	/// [`Self::open_dir_beneath_async`] does, then the file relative to that
	/// directory without following a symlink there (`O_NOFOLLOW`; on Windows
	/// `FILE_OPEN_REPARSE_POINT`, refusing the reparse point it reached), and
	/// truncate only once the open file is known to be a regular one, so a
	/// special file is left as it was (FIFOs never block the open).
	///
	/// Providers check the final component with `symlink_metadata` and
	/// refuse a symlink or a special file there, then write by path, with the
	/// limits [`Self::open_regular_beneath_async`] describes.
	///
	/// # Errors
	///
	/// [`io::ErrorKind::InvalidInput`] for a `rel` that is not walk-relative,
	/// the refusal of a symlink, [`is_not_regular`] for special files (a
	/// directory fails the open itself), and the open's and the write's own
	/// errors.
	pub async fn write_beneath_async(&self, rel: &[u8], contents: &[u8]) -> io::Result<()> {
		check_relative(rel)?;
		match &self.repr {
			DirRepr::Host { handle, .. } => {
				with_scratch(|s| native::write_file_beneath(s, handle, rel, contents))
			},
			DirRepr::Provider(provided) => {
				provider::write_file_unlinked(
					&provided.fs,
					&provider::beneath(&provided.path, rel),
					contents,
				)
				.await
			},
		}
	}

	/// Removes the entry at the walk-relative `rel` below this directory,
	/// following no symlink on the way: the entry removed is below this
	/// directory or nothing is, also when a directory on the way was replaced
	/// by a symlink since the listing. With `dir` the entry must be an empty
	/// directory, else a file, a symlink (removed itself, as `unlink` removes
	/// it) or a special file. On Windows a directory symlink or junction is a
	/// directory, which only `dir` removes, as [`std::fs::remove_dir`] removes
	/// it there; an empty directory with the read-only attribute is removed
	/// too, as `rmdir` removes one on Unix, where [`std::fs::remove_dir`]
	/// refuses it. This is how a walk that does not follow symlinks removes
	/// an entry it listed.
	///
	/// Host removals open the entry's directory as
	/// [`Self::open_dir_beneath_async`] does, then remove the entry relative
	/// to it (`unlinkat`; on Windows a delete disposition on the entry opened
	/// with `FILE_OPEN_REPARSE_POINT`). Providers remove by path, resolving
	/// the directories on the way themselves (see
	/// [`Self::open_regular_beneath_async`]).
	///
	/// # Errors
	///
	/// [`io::ErrorKind::InvalidInput`] for a `rel` that is not walk-relative,
	/// the refusal of a symlink on the way, and the removal's own errors (a
	/// directory at `rel` without `dir` fails, as [`std::fs::remove_file`]
	/// fails, and a `rel` that is not an empty directory with `dir` fails, as
	/// [`std::fs::remove_dir`] fails).
	pub async fn remove_beneath_async(&self, rel: &[u8], dir: bool) -> io::Result<()> {
		check_relative(rel)?;
		match &self.repr {
			DirRepr::Host { handle, .. } => {
				with_scratch(|s| native::remove_beneath(s, handle, rel, dir))
			},
			DirRepr::Provider(provided) => {
				provider::remove(&provided.fs, &provider::beneath(&provided.path, rel), dir).await
			},
		}
	}

	/// This directory's change stamp.
	///
	/// # Errors
	///
	/// The status query's errors.
	pub async fn stamp_async(&self) -> io::Result<Stamp> {
		match &self.repr {
			DirRepr::Host { handle, .. } => native::stat_dir(handle),
			DirRepr::Provider(provided) => provider::stat(&provided.fs, &provided.path, true)
				.await
				.map(|info| info.stamp),
		}
	}

	/// Whether every change to a directory on this directory's filesystem
	/// (whose stamp is `stamp`) yields a different stamp: timestamps are
	/// fine-grained and maintained locally (APFS; ext4, XFS, Btrfs, tmpfs,
	/// F2FS, ZFS, bcachefs; NTFS, `ReFS`). Always false for providers.
	/// Listing caches rely on it.
	pub fn stable_stamps(&self, stamp: &Stamp) -> bool {
		match &self.repr {
			DirRepr::Host { handle, .. } => native::stable_stamps(handle, stamp),
			DirRepr::Provider(_) => false,
		}
	}
}

/// Where a test makes its trees: Bazel's per-test `TEST_TMPDIR` when it is
/// set, else the system's temporary directory (see pi-walker's
/// `testing::temp_root`, which says why).
#[cfg(test)]
pub(crate) fn temp_root() -> PathBuf {
	std::env::var_os("TEST_TMPDIR")
		.map(PathBuf::from)
		.filter(|dir| dir.is_dir())
		.unwrap_or_else(std::env::temp_dir)
}

/// Runs the test `name` (its path in this crate) again in a process of its
/// own, and fails when that run fails or runs no test: `true` here, `false`
/// in that process, which runs the test's body. For a test that reads or
/// sets what is the process's (the kernel fallbacks, the scratch pool, the
/// umask), so no other test of the same process changes it meanwhile.
#[cfg(all(test, unix))]
pub(crate) fn alone(name: &str) -> bool {
	const ALONE: &str = "PI_VFS_TEST_ALONE";
	if std::env::var_os(ALONE).is_some_and(|alone| alone == name) {
		return false;
	}
	let output = std::process::Command::new(std::env::current_exe().expect("the test binary"))
		.args(["--exact", name, "--nocapture", "--test-threads=1"])
		.env(ALONE, name)
		.output()
		.expect("run the test in a process of its own");
	let (out, err) =
		(String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
	assert!(output.status.success(), "{name} failed in a process of its own:\n{out}\n{err}");
	assert!(out.contains("1 passed"), "{name} ran no test in a process of its own:\n{out}\n{err}");
	true
}
