//! Filesystem layer every walk and search reads through: directory listings,
//! file contents, and change stamps.
//!
//! [`Fs::Native`] is the host filesystem with per-platform fast paths
//! (`native/`); [`Fs::Provider`] adapts a [`pi_vfs::Fs`] provider
//! (`provider.rs`), such as an in-memory tree or a `scheme://` URL namespace.
//! Walkers, ignore loading, the listing cache, and the searches only ever talk
//! to an [`Fs`], so no tool bypasses the layer with its own I/O.
//!
//! Work happens on a [`Session`]: per-thread scratch that makes steady-state
//! listing and stat calls allocation-free. Walkers hold one session per
//! worker. Directories are opened once ([`Session::open_dir`], then
//! [`Session::open_child`] relative to the parent) and files are opened once
//! ([`Session::open_file_at`], which also stats them) and then read into a
//! reusable buffer ([`File::read_into`]) or streamed ([`File::read`]).
//!
//! A walk that does not follow symlinks opens nothing through one: child
//! directories and listed files open relative to the listed directory's
//! handle without following a symlink there ([`Session::open_child`],
//! [`Session::open_file_at`] without `follow`), and an entry whose listing
//! carries no handle opens below the walk root's handle with no symlink
//! followed on the way ([`Session::open_file_beneath`],
//! [`Session::open_dir_beneath`]). Consumers write back and remove listed
//! entries below the root the same way ([`Session::write_file_beneath`],
//! [`Session::remove_file_beneath`], [`Session::remove_dir_beneath`]). Only
//! the root itself, and files named outside it (git's global excludes,
//! ancestors' ignore files), open by path.
//!
//! ```ignore
//! let fs = Fs::native();
//! let mut s = fs.session();
//! let dir = s.open_dir(Path::new("/repo")).await?;
//! let listing = s.list(&dir, Detail::Minimal, 0).await?;
//! for record in listing.records() {
//!     println!("{:?} {:?}", listing.name(record), record.file_type);
//! }
//! ```

mod native;
mod provider;
mod root;
#[cfg(any(windows, test))]
mod wtf8;

use std::{
	borrow::Cow,
	ffi::OsStr,
	io,
	path::{Path, PathBuf},
};

pub use root::{absolute, canonical, resolve_dir};

/// Kind of a listed entry. Special files (devices, FIFOs, sockets) are never
/// reported by listings; on Windows every reparse point is a [`Self::Symlink`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FileType {
	/// A regular file.
	File,
	/// A directory.
	Dir,
	/// A symbolic link (never followed by a listing).
	Symlink,
}

/// How much metadata listings collect.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Detail {
	/// Names and entry types only: one bulk listing call per directory and no
	/// per-entry metadata syscalls.
	#[default]
	Minimal,
	/// Also modification times for every entry and sizes for regular files.
	/// macOS and Windows return these from the bulk listing; Linux and
	/// providers pay one metadata call per entry.
	Full,
}

/// Identity of a file or directory, regardless of the path reaching it.
///
/// Device and inode on Unix, volume serial and file index on Windows, and
/// the provider's own ids otherwise. Provider and host ids live in separate
/// namespaces (`native`), so they never compare equal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FileId {
	/// Device (Unix) or volume serial number (Windows).
	pub dev:    u64,
	/// Inode (Unix) or file index (Windows).
	pub ino:    u64,
	/// The id comes from the host, not a provider.
	pub native: bool,
}

/// One version of a file or directory.
///
/// Adding, removing, or renaming a directory's entries moves its mtime and
/// ctime, and replacing it changes its inode. Listing caches compare stamps to
/// decide whether a listing is still current.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Stamp {
	/// Device or volume serial number.
	pub dev:   u64,
	/// Inode or file index (Windows path queries: creation time).
	pub ino:   u64,
	/// Modification time, Unix nanoseconds.
	pub mtime: i64,
	/// Status-change time, Unix nanoseconds.
	pub ctime: i64,
}

impl Stamp {
	/// The newer of the two timestamps.
	pub const fn latest(&self) -> i64 {
		if self.mtime > self.ctime {
			self.mtime
		} else {
			self.ctime
		}
	}
}

/// Metadata of a file opened by [`Session::open_file_at`] or found by
/// [`Session::stat`].
#[derive(Clone, Copy, Debug)]
pub struct FileInfo {
	/// `None` for special files (devices, FIFOs, sockets).
	pub file_type: Option<FileType>,
	/// Byte size.
	pub size:      u64,
	/// Change stamp (also carries the modification time).
	pub stamp:     Stamp,
}

/// One listing entry; its name lives in the owning [`Listing`].
#[derive(Clone, Copy, Debug)]
pub struct Record {
	pub(crate) name_off: u32,
	pub(crate) name_len: u32,
	/// A subdirectory's entry count when the listing reports it (macOS full
	/// listings), else 0. Passed back to [`Session::list`] for the child, it
	/// lets the child's listing stop without a final empty read.
	pub children:        u32,
	/// Entry kind as listed (symlinks unresolved).
	pub file_type:       FileType,
	/// Regular-file size, when the listing carries it.
	pub size:            Option<u64>,
	/// Modification time in Unix nanoseconds, when the listing carries it.
	pub mtime:           Option<i64>,
}

/// One directory's entries, without `.` and `..` and without special files.
/// Names are raw bytes (`OsStr` encoded bytes: exact on Unix, WTF-8 on
/// Windows and for provider names).
#[derive(Clone, Debug, Default)]
pub struct Listing {
	pub(crate) records: Vec<Record>,
	pub(crate) names:   Vec<u8>,
}

impl Listing {
	/// Entries in listing order.
	pub fn records(&self) -> &[Record] {
		&self.records
	}

	/// The name of `record`, which must come from this listing.
	pub fn name(&self, record: &Record) -> &[u8] {
		let start = record.name_off as usize;
		&self.names[start..start + record.name_len as usize]
	}

	/// Number of entries.
	pub const fn len(&self) -> usize {
		self.records.len()
	}

	/// The directory has no listed entries.
	pub const fn is_empty(&self) -> bool {
		self.records.is_empty()
	}

	/// Approximate heap footprint in bytes, for cache budgets.
	pub const fn heap_size(&self) -> usize {
		self.names.len() + self.records.len() * size_of::<Record>()
	}

	pub(crate) fn clear(&mut self) {
		self.records.clear();
		self.names.clear();
	}

	pub(crate) fn push(
		&mut self,
		name: &[u8],
		file_type: FileType,
		size: Option<u64>,
		mtime: Option<i64>,
		children: u32,
	) {
		self.push_with(|names| names.extend_from_slice(name), file_type, size, mtime, children);
	}

	/// [`Self::push`] with the name appended to the arena by `write_name`.
	pub(crate) fn push_with(
		&mut self,
		write_name: impl FnOnce(&mut Vec<u8>),
		file_type: FileType,
		size: Option<u64>,
		mtime: Option<i64>,
		children: u32,
	) {
		let name_off = self.names.len();
		write_name(&mut self.names);
		self.records.push(Record {
			name_off: name_off as u32,
			name_len: (self.names.len() - name_off) as u32,
			children,
			file_type,
			size,
			mtime,
		});
	}
}

/// A filesystem walks and searches read through. Cheap to clone.
#[derive(Clone, Debug)]
pub enum Fs {
	/// The host filesystem through direct syscalls.
	Native,
	/// A provider (or any facade path that is not plain host storage), read
	/// through its [`pi_vfs::Fs`] methods.
	Provider(pi_vfs::Fs),
}

impl Fs {
	/// The host filesystem.
	pub const fn native() -> Self {
		Self::Native
	}

	/// The layer that serves `root` and everything below it on `fs`:
	/// [`Self::Native`] when `fs.is_native_local(root)`, else
	/// [`Self::Provider`].
	pub fn new(fs: &pi_vfs::Fs, root: &Path) -> Self {
		if fs.is_native_local(root) {
			Self::Native
		} else {
			Self::Provider(fs.clone())
		}
	}

	/// Whether this is [`Self::Native`].
	pub const fn is_native(&self) -> bool {
		matches!(self, Self::Native)
	}

	/// A fresh per-thread session. Cheap: scratch buffers grow on first use.
	pub fn session(&self) -> Session {
		let imp = match self {
			Self::Native => Imp::Native(native::Scratch::default()),
			Self::Provider(fs) => Imp::Provider(fs.clone()),
		};
		Session { listing: Listing::default(), imp }
	}

	/// Parallelism past which concurrent listing costs more than it gains:
	/// 4 on macOS (APFS contention), 8 on Linux, 4 elsewhere and for
	/// providers.
	pub const fn workers(&self) -> usize {
		match self {
			Self::Native => native::WORKERS,
			Self::Provider(_) => 4,
		}
	}

	/// Absolute spelling of the walk-relative `rel` (`/`-separated raw
	/// names; empty for `root` itself) below `root`. Host paths join with
	/// the platform separator; URL roots join segment by segment with
	/// [`pi_vfs::child_path`], which percent-encodes raw names.
	pub fn join(&self, root: &Path, rel: &[u8]) -> PathBuf {
		let mut path = PathBuf::new();
		self.join_into(&mut path, root, rel);
		path
	}

	/// [`Self::join`] into `out`, replacing its contents and reusing its
	/// allocation.
	pub fn join_into(&self, out: &mut PathBuf, root: &Path, rel: &[u8]) {
		out.clear();
		out.push(root);
		if rel.is_empty() {
			return;
		}
		if pi_vfs::is_virtual_path(root) {
			for segment in rel
				.split(|&b| b == b'/')
				.filter(|segment| !segment.is_empty())
			{
				*out = pi_vfs::child_path(out, &os_name(segment));
			}
		} else {
			out.push(os_name(rel));
		}
	}
}

/// `bytes` (raw `OsStr` encoded bytes: exact on Unix, WTF-8 on Windows) as an
/// [`OsStr`]. On Windows `/` becomes `\`.
#[cfg(unix)]
pub(crate) fn os_name(bytes: &[u8]) -> Cow<'_, OsStr> {
	use std::os::unix::ffi::OsStrExt;
	Cow::Borrowed(OsStr::from_bytes(bytes))
}

/// `bytes` (raw `OsStr` encoded bytes: exact on Unix, WTF-8 on Windows) as an
/// [`OsStr`]. On Windows `/` becomes `\`.
#[cfg(windows)]
pub(crate) fn os_name(bytes: &[u8]) -> Cow<'_, OsStr> {
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

/// An open directory. Native: a descriptor/handle closed on drop. Provider:
/// the directory's path.
#[derive(Debug)]
pub struct Dir {
	repr: DirRepr,
}

#[derive(Debug)]
enum DirRepr {
	Native(native::Handle),
	Provider(PathBuf),
}

/// An open regular file, read with [`File::read_into`] or streamed through
/// [`File::read`]. Closed on drop.
#[derive(Debug)]
pub struct File {
	repr: FileRepr,
	size: u64,
	/// Stream position of [`File::read`].
	pos:  u64,
}

#[derive(Debug)]
enum FileRepr {
	Native(native::Handle),
	Provider(pi_vfs::File),
}

impl File {
	/// Size reported when the file was opened.
	pub const fn size(&self) -> u64 {
		self.size
	}

	/// Replaces `buf`'s contents with up to `limit` leading bytes of the file.
	/// Reads stop at the size reported at open time or at end of file: a read
	/// that returns exactly the remaining size is taken as end of file (no
	/// confirming zero-length read), and growth after the open is not read;
	/// files reporting size 0 (pseudo files) and short reads keep reading
	/// until end of file or `limit`. A size the allocator refuses (beyond the
	/// address space, or above memory where overcommit is limited) fails with
	/// [`io::ErrorKind::OutOfMemory`], as [`std::fs::read`] fails, instead of
	/// aborting the process; a size it grants is read as `std::fs::read`
	/// reads it.
	pub async fn read_into(&mut self, buf: &mut Vec<u8>, limit: u64) -> io::Result<()> {
		buf.clear();
		self.read_more(buf, limit).await
	}

	/// Continues [`Self::read_into`]: appends the file's bytes from offset
	/// `buf.len()`, taking the bytes `buf` holds as the file's first ones (as
	/// an earlier `read_into` or `read_more` left them), so no byte is read
	/// twice. Stops where `read_into` stops: at `limit` bytes in all, at the
	/// size reported at open time, or at end of file.
	pub async fn read_more(&mut self, buf: &mut Vec<u8>, limit: u64) -> io::Result<()> {
		match &mut self.repr {
			FileRepr::Native(handle) => {
				fill(buf, self.size, limit, |buf, end| native::read_append(handle, buf, end))
			},
			FileRepr::Provider(file) => {
				let start = buf.len() as u64;
				if self.pos != start {
					file.seek_async(io::SeekFrom::Start(start)).await?;
					self.pos = start;
				}
				let window = Fill::new(buf, self.size, limit)?;
				while let Some(end) = window.next(buf)? {
					let len = buf.len();
					buf.resize(end, 0);
					let read = file.read_async(&mut buf[len..]).await;
					buf.truncate(len + *read.as_ref().unwrap_or(&0));
					if !Fill::more(read)? {
						break;
					}
				}
				self.pos = buf.len() as u64;
				Ok(())
			},
		}
	}
}

/// The read loop of [`File::read_more`], shared by its sync (native) and
/// async (provider) arms.
struct Fill {
	bound: usize,
}

impl Fill {
	/// Reserves `buf` for reading on to `limit` bytes in all of a file whose
	/// size at open time was `size` (0: empty or a pseudo file, read to end
	/// of file); the bytes `buf` already holds are the file's first ones.
	fn new(buf: &mut Vec<u8>, size: u64, limit: u64) -> io::Result<Self> {
		let limit = usize::try_from(limit).unwrap_or(usize::MAX);
		let bound = if size > 0 {
			usize::try_from(size).unwrap_or(usize::MAX).min(limit)
		} else {
			limit
		};
		let want = bound.saturating_sub(buf.len());
		try_reserve(buf, if size > 0 { want } else { want.min(4096) })?;
		Ok(Self { bound })
	}

	/// End of the next read window (growing `buf`), `None` once full.
	fn next(&self, buf: &mut Vec<u8>) -> io::Result<Option<usize>> {
		if buf.len() >= self.bound {
			return Ok(None);
		}
		if buf.len() == buf.capacity() {
			let grown = buf
				.capacity()
				.saturating_mul(2)
				.saturating_add(4096)
				.min(self.bound);
			try_reserve(buf, grown - buf.len())?;
		}
		Ok(Some(buf.capacity().min(self.bound)))
	}

	/// Whether to keep reading after a read returned `read` (0 is end of
	/// file; interrupted reads retry).
	fn more(read: io::Result<usize>) -> io::Result<bool> {
		match read {
			Ok(0) => Ok(false),
			Ok(_) => Ok(true),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => Ok(true),
			Err(err) => Err(err),
		}
	}
}

/// Appends to `buf` through `read` until end of file or `limit` bytes in all,
/// given the `size` reported at open time; see [`File::read_more`].
/// `read(buf, end)` appends at most `end - buf.len()` bytes and returns the
/// count (0 at end of file).
fn fill(
	buf: &mut Vec<u8>,
	size: u64,
	limit: u64,
	mut read: impl FnMut(&mut Vec<u8>, usize) -> io::Result<usize>,
) -> io::Result<()> {
	let window = Fill::new(buf, size, limit)?;
	while let Some(end) = window.next(buf)? {
		if !Fill::more(read(buf, end))? {
			break;
		}
	}
	Ok(())
}

/// Reserves `additional` more bytes in `buf`, failing with
/// [`io::ErrorKind::OutOfMemory`] when the allocator refuses, as
/// [`std::fs::read`] does, rather than aborting.
fn try_reserve(buf: &mut Vec<u8>, additional: usize) -> io::Result<()> {
	buf.try_reserve(additional)
		.map_err(|_| io::Error::from(io::ErrorKind::OutOfMemory))
}

/// Sequential reads of a native [`File`], executed inline (see
/// [`File::native_reader`]).
pub struct NativeReader<'a> {
	handle: &'a native::Handle,
	pos:    &'a mut u64,
}

impl io::Read for NativeReader<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let n = native::read_at(self.handle, buf, *self.pos)?;
		*self.pos += n as u64;
		Ok(n)
	}
}

impl File {
	/// Reads the next bytes of the file into `buf`, returning the count (0 at
	/// end of file).
	pub async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let n = match &mut self.repr {
			FileRepr::Native(handle) => native::read_at(handle, buf, self.pos)?,
			FileRepr::Provider(file) => file.read_async(buf).await?,
		};
		self.pos += n as u64;
		Ok(n)
	}

	/// A synchronous reader continuing at the stream position, for native
	/// files (plain syscalls, like every native operation); `None` for
	/// provider files, which are only read asynchronously.
	pub const fn native_reader(&mut self) -> Option<NativeReader<'_>> {
		match &self.repr {
			FileRepr::Native(handle) => Some(NativeReader { handle, pos: &mut self.pos }),
			FileRepr::Provider(_) => None,
		}
	}

	/// The identity of the open file, read from the handle rather than from
	/// the path it was opened by: a name replaced after the open still reports
	/// the file that was opened.
	///
	/// # Errors
	///
	/// The handle's (or provider's) status query.
	pub fn metadata(&self) -> io::Result<pi_vfs::Metadata> {
		match &self.repr {
			FileRepr::Native(handle) => native::handle_metadata(handle),
			FileRepr::Provider(file) => file.metadata(),
		}
	}

	/// The open file as a [`pi_vfs::File`], for readers built on `pi_vfs`:
	/// the same open file (no reopen by path). A native file reads from its
	/// start, a provider file from where this file's reads left it.
	pub fn into_vfs(self) -> pi_vfs::File {
		match self.repr {
			FileRepr::Native(handle) => pi_vfs::File::from(std::fs::File::from(handle)),
			FileRepr::Provider(file) => file,
		}
	}
}

/// Marker error behind [`is_not_regular`].
#[derive(Debug)]
struct NotRegular;

impl std::fmt::Display for NotRegular {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str("not a regular file")
	}
}

impl std::error::Error for NotRegular {}

/// The error for opening a directory or special file as a regular file.
pub(crate) fn not_regular() -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, NotRegular)
}

/// Whether `err` is the error [`Session::open_file_at`],
/// [`Session::open_file`], and [`Session::open_file_beneath`] return for
/// directories and special files.
pub fn is_not_regular(err: &io::Error) -> bool {
	err.get_ref().is_some_and(|inner| inner.is::<NotRegular>())
}

/// Marker error behind a provider's refusal of a final symlink, which
/// [`is_symlink_refusal`] recognizes.
#[derive(Debug)]
struct SymlinkRefused;

impl std::fmt::Display for SymlinkRefused {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
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
/// [`Session::open_file_beneath`] the symlink may be the file or a directory
/// on the way; opening the file's directory below the same root tells the
/// two apart.
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

/// Per-thread filesystem operations. Slices returned by a method stay valid
/// until the next call of the same method.
pub struct Session {
	listing: Listing,
	imp:     Imp,
}

enum Imp {
	Native(native::Scratch),
	Provider(pi_vfs::Fs),
}

/// A directory from another kind of [`Fs`] than the session's.
fn foreign_dir() -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, "directory belongs to another filesystem")
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
/// `beneath` open splits it here, so both agree on its components.
pub const fn is_rel_separator(byte: u8) -> bool {
	byte == b'/' || (cfg!(windows) && byte == b'\\')
}

impl Session {
	/// Opens the directory at an absolute path, following symlinks.
	pub async fn open_dir(&mut self, path: &Path) -> io::Result<Dir> {
		#[cfg(test)]
		seam::fire(seam::last(path), seam::Open::Path);
		let repr = match &mut self.imp {
			Imp::Native(s) => DirRepr::Native(native::open_dir(s, path)?),
			Imp::Provider(fs) => DirRepr::Provider(provider::open_dir(fs, path).await?),
		};
		Ok(Dir { repr })
	}

	/// Opens the subdirectory `name` of `parent` without following a symlink
	/// that replaced it since `parent` was listed.
	pub async fn open_child(&mut self, parent: &Dir, name: &[u8]) -> io::Result<Dir> {
		#[cfg(test)]
		seam::fire(name, seam::Open::At);
		let repr = match (&mut self.imp, &parent.repr) {
			(Imp::Native(s), DirRepr::Native(h)) => DirRepr::Native(native::open_child(s, h, name)?),
			(Imp::Provider(fs), DirRepr::Provider(path)) => {
				DirRepr::Provider(provider::open_child(fs, path, name).await?)
			},
			_ => return Err(foreign_dir()),
		};
		Ok(Dir { repr })
	}

	/// Lists every entry of `dir` except `.` and `..`, skipping special files
	/// and entries that vanish between listing and their metadata lookup.
	/// `children` is the entry count from the parent's listing (0 when
	/// unknown); readers may use it to end early. Provider listings reject
	/// names that are not a single path component with
	/// [`io::ErrorKind::InvalidData`]. A native handle reads from its current
	/// position (no rewind syscall), so list each [`Dir`] once; open it again
	/// to list it again.
	pub async fn list(&mut self, dir: &Dir, detail: Detail, children: u32) -> io::Result<&Listing> {
		list_with(&mut self.imp, dir, detail, children, &mut self.listing).await?;
		Ok(&self.listing)
	}

	/// [`Self::list`] into a caller-owned listing (cleared first), so callers
	/// can keep it while using the session again.
	pub(crate) async fn list_into(
		&mut self,
		dir: &Dir,
		detail: Detail,
		children: u32,
		out: &mut Listing,
	) -> io::Result<()> {
		list_with(&mut self.imp, dir, detail, children, out).await
	}

	/// Opens the regular file `name` (one component) in `dir` and describes
	/// it. With `follow`, a symlink there is followed, as an open by path
	/// follows it. Without, a symlink there is refused (`ELOOP` on Unix,
	/// `ERROR_STOPPED_ON_SYMLINK` for any reparse point on Windows): a walk
	/// that does not follow symlinks reads the file it listed or nothing, also
	/// when the name was replaced by a symlink since the listing. Fails for
	/// directories and special files (see [`is_not_regular`]); FIFOs never
	/// block the open. Providers check the name and then open it, see
	/// [`Self::open_file_beneath`].
	pub async fn open_file_at(
		&mut self,
		dir: &Dir,
		name: &[u8],
		follow: bool,
	) -> io::Result<(File, FileInfo)> {
		#[cfg(test)]
		seam::fire(name, seam::Open::At);
		let (repr, info) = match (&mut self.imp, &dir.repr) {
			(Imp::Native(s), DirRepr::Native(h)) => {
				let (handle, info) = native::open_file_at(s, h, name, follow)?;
				(FileRepr::Native(handle), info)
			},
			(Imp::Provider(fs), DirRepr::Provider(path)) => {
				let path = provider::child(path, name);
				let (file, info) = if follow {
					provider::open_file(fs, &path).await?
				} else {
					provider::open_file_unlinked(fs, &path).await?
				};
				(FileRepr::Provider(file), info)
			},
			_ => return Err(foreign_dir()),
		};
		Ok((File { repr, size: info.size, pos: 0 }, info))
	}

	/// Opens the regular file at the walk-relative `rel` (`/`-separated raw
	/// names, none of them empty, `.`, or `..`; on Windows `\` separates them
	/// too) below the open directory `root`, following no symlink on the way:
	/// neither the file nor any directory between `root` and it, also one
	/// swapped in since the listing. This is how a walk that does not follow
	/// symlinks opens a file whose listing carries no directory handle.
	///
	/// Native opens resolve below `root`'s handle, never by path: on Linux
	/// one `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` where the
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
	pub async fn open_file_beneath(
		&mut self,
		root: &Dir,
		rel: &[u8],
	) -> io::Result<(File, FileInfo)> {
		check_relative(rel)?;
		#[cfg(test)]
		seam::fire(seam::last_of(rel), seam::Open::Beneath);
		let (repr, info) = match (&mut self.imp, &root.repr) {
			(Imp::Native(s), DirRepr::Native(h)) => {
				let (handle, info) = native::open_file_beneath(s, h, rel)?;
				(FileRepr::Native(handle), info)
			},
			(Imp::Provider(fs), DirRepr::Provider(path)) => {
				let (file, info) =
					provider::open_file_unlinked(fs, &provider::beneath(path, rel)).await?;
				(FileRepr::Provider(file), info)
			},
			_ => return Err(foreign_dir()),
		};
		Ok((File { repr, size: info.size, pos: 0 }, info))
	}

	/// Opens the directory at the walk-relative `rel` below the open directory
	/// `root`, following no symlink on the way, as [`Self::open_file_beneath`]
	/// opens a file (with the same provider limits). This is how a walk that
	/// does not follow symlinks opens a directory whose parent's listing
	/// carries no handle.
	///
	/// # Errors
	///
	/// As for [`Self::open_file_beneath`]; a `rel` that is not a directory
	/// fails like [`Self::open_child`].
	pub async fn open_dir_beneath(&mut self, root: &Dir, rel: &[u8]) -> io::Result<Dir> {
		check_relative(rel)?;
		#[cfg(test)]
		seam::fire(seam::last_of(rel), seam::Open::Beneath);
		let repr = match (&mut self.imp, &root.repr) {
			(Imp::Native(s), DirRepr::Native(h)) => {
				DirRepr::Native(native::open_dir_beneath(s, h, rel)?)
			},
			(Imp::Provider(fs), DirRepr::Provider(path)) => {
				DirRepr::Provider(provider::open_dir_unlinked(fs, provider::beneath(path, rel)).await?)
			},
			_ => return Err(foreign_dir()),
		};
		Ok(Dir { repr })
	}

	/// Replaces the contents of the regular file at the walk-relative `rel`
	/// below the open directory `root` with `contents`, creating the file
	/// when it is missing, and follows no symlink on the way or at the file:
	/// the write lands on a file below `root` or nowhere, also when a
	/// directory on the way or the file itself was replaced by a symlink
	/// since the listing. This is how a walk that does not follow symlinks
	/// writes back a file it listed.
	///
	/// The file is rewritten in place, as [`std::fs::write`] and
	/// [`pi_vfs::Fs::write`] rewrite it: one open, truncated, then written,
	/// so its identity, permissions, owner, and hard links stay, and a new
	/// file gets mode `0o666` less the umask. Native writes open the file's
	/// directory as [`Self::open_dir_beneath`] does, then the file relative
	/// to that directory without following a symlink there (`O_NOFOLLOW`;
	/// on Windows `FILE_OPEN_REPARSE_POINT`, refusing the reparse point it
	/// reached), and truncate only once the open file is known to be a
	/// regular one, so a special file is left as it was (FIFOs never block
	/// the open).
	///
	/// Providers check the final component with `symlink_metadata` and
	/// refuse a symlink or a special file there, then write by path, with
	/// the limits [`Self::open_file_beneath`] describes.
	///
	/// # Errors
	///
	/// [`io::ErrorKind::InvalidInput`] for a `rel` that is not walk-relative,
	/// the refusal of a symlink, [`is_not_regular`] for special files (a
	/// directory fails the open itself), and the open's and the write's own
	/// errors.
	pub async fn write_file_beneath(
		&mut self,
		root: &Dir,
		rel: &[u8],
		contents: &[u8],
	) -> io::Result<()> {
		check_relative(rel)?;
		match (&mut self.imp, &root.repr) {
			(Imp::Native(s), DirRepr::Native(h)) => native::write_file_beneath(s, h, rel, contents),
			(Imp::Provider(fs), DirRepr::Provider(path)) => {
				provider::write_file_unlinked(fs, &provider::beneath(path, rel), contents).await
			},
			_ => Err(foreign_dir()),
		}
	}

	/// Removes the file, symlink, or special file at the walk-relative `rel`
	/// below the open directory `root`, following no symlink on the way: the
	/// entry removed is below `root` or nothing is, also when a directory on
	/// the way was replaced by a symlink since the listing. A symlink at
	/// `rel` is removed itself, as `unlink` removes it; on Windows a
	/// directory symlink or junction is a directory, which this call refuses
	/// as [`std::fs::remove_file`] refuses it there, and
	/// [`Self::remove_dir_beneath`] removes. This is how a walk that does not
	/// follow symlinks removes an entry it listed.
	///
	/// Native removals open the entry's directory as
	/// [`Self::open_dir_beneath`] does, then remove the entry relative to it
	/// (`unlinkat`; on Windows a delete disposition on the entry opened with
	/// `FILE_OPEN_REPARSE_POINT`). Providers remove by path, resolving the
	/// directories on the way themselves (see [`Self::open_file_beneath`]).
	///
	/// # Errors
	///
	/// [`io::ErrorKind::InvalidInput`] for a `rel` that is not walk-relative,
	/// the refusal of a symlink on the way, and the removal's own errors (a
	/// directory at `rel` fails, as [`std::fs::remove_file`] fails).
	pub async fn remove_file_beneath(&mut self, root: &Dir, rel: &[u8]) -> io::Result<()> {
		self.remove_beneath(root, rel, false).await
	}

	/// Removes the empty directory at the walk-relative `rel` below the open
	/// directory `root`, following no symlink on the way, as
	/// [`Self::remove_file_beneath`] removes a file (`unlinkat` with
	/// `AT_REMOVEDIR`).
	///
	/// # Errors
	///
	/// As for [`Self::remove_file_beneath`]; a `rel` that is not an empty
	/// directory fails, as [`std::fs::remove_dir`] fails. On Windows a
	/// directory symlink or junction at `rel` is removed itself (not its
	/// target), as [`std::fs::remove_dir`] removes it there, and an empty
	/// directory with the read-only attribute is removed too, as `rmdir`
	/// removes one on Unix, where [`std::fs::remove_dir`] refuses it.
	pub async fn remove_dir_beneath(&mut self, root: &Dir, rel: &[u8]) -> io::Result<()> {
		self.remove_beneath(root, rel, true).await
	}

	async fn remove_beneath(&mut self, root: &Dir, rel: &[u8], dir: bool) -> io::Result<()> {
		check_relative(rel)?;
		match (&mut self.imp, &root.repr) {
			(Imp::Native(s), DirRepr::Native(h)) => native::remove_beneath(s, h, rel, dir),
			(Imp::Provider(fs), DirRepr::Provider(path)) => {
				provider::remove(fs, &provider::beneath(path, rel), dir).await
			},
			_ => Err(foreign_dir()),
		}
	}

	/// Opens the regular file at an absolute path, following symlinks, and
	/// describes it; fails like [`Self::open_file_at`].
	pub async fn open_file(&mut self, path: &Path) -> io::Result<(File, FileInfo)> {
		#[cfg(test)]
		seam::fire(seam::last(path), seam::Open::Path);
		let (repr, info) = match &mut self.imp {
			Imp::Native(s) => {
				let (handle, info) = native::open_file(s, path)?;
				(FileRepr::Native(handle), info)
			},
			Imp::Provider(fs) => {
				let (file, info) = provider::open_file(fs, path).await?;
				(FileRepr::Provider(file), info)
			},
		};
		Ok((File { repr, size: info.size, pos: 0 }, info))
	}

	/// Describes the file or directory at an absolute path, following a final
	/// symlink only when `follow` is set.
	pub async fn stat(&mut self, path: &Path, follow: bool) -> io::Result<FileInfo> {
		#[cfg(test)]
		seam::fire(seam::last(path), seam::Open::Stat);
		match &mut self.imp {
			Imp::Native(s) => native::stat(s, path, follow),
			Imp::Provider(fs) => provider::stat(fs, path, follow).await,
		}
	}

	/// Stamps an open directory.
	pub async fn stat_dir(&mut self, dir: &Dir) -> io::Result<Stamp> {
		match (&mut self.imp, &dir.repr) {
			(Imp::Native(_), DirRepr::Native(h)) => native::stat_dir(h),
			(Imp::Provider(fs), DirRepr::Provider(path)) => {
				provider::stat(fs, path, true).await.map(|info| info.stamp)
			},
			_ => Err(foreign_dir()),
		}
	}

	/// Identity of the file or directory at an absolute path, following
	/// symlinks. Walkers compare identities to stop symlink cycles and to
	/// stay on one filesystem.
	pub async fn identify(&mut self, path: &Path) -> io::Result<FileId> {
		match &mut self.imp {
			Imp::Native(s) => native::identify(s, path),
			Imp::Provider(fs) => provider::identify(fs, path).await,
		}
	}

	/// Identity of an open directory.
	pub async fn identify_dir(&mut self, dir: &Dir) -> io::Result<FileId> {
		match (&mut self.imp, &dir.repr) {
			(Imp::Native(_), DirRepr::Native(h)) => native::identify_dir(h),
			(Imp::Provider(fs), DirRepr::Provider(path)) => provider::identify(fs, path).await,
			_ => Err(foreign_dir()),
		}
	}

	/// Whether every change to a directory on `dir`'s filesystem (whose stamp
	/// is `stamp`) yields a different stamp: timestamps are fine-grained and
	/// maintained locally (APFS; ext4, XFS, Btrfs, tmpfs, F2FS, ZFS,
	/// bcachefs; NTFS, `ReFS`). Always false for providers. Listing caches rely
	/// on it.
	pub fn stable_stamps(&mut self, dir: &Dir, stamp: &Stamp) -> bool {
		match (&self.imp, &dir.repr) {
			(Imp::Native(_), DirRepr::Native(h)) => native::stable_stamps(h, stamp),
			_ => false,
		}
	}
}

/// Opens regular files by absolute path relative to their directory.
///
/// It follows symlinks, as any open by path does, so it confines nothing: a
/// walk that must not follow symlinks opens through
/// [`Session::open_file_at`] or [`Session::open_file_beneath`] instead.
///
/// It keeps the directory open: consecutive files of one directory (a walk's
/// output in path order) cost one single-component lookup each instead of a
/// full path resolution.
pub struct FileOpener {
	session:  Session,
	/// Path of `dir`.
	dir_path: PathBuf,
	dir:      Option<Dir>,
}

impl FileOpener {
	/// An opener on `fs`.
	pub fn new(fs: &Fs) -> Self {
		Self { session: fs.session(), dir_path: PathBuf::new(), dir: None }
	}

	/// Opens the regular file at the absolute `path` like
	/// [`Session::open_file`], through its directory.
	///
	/// # Errors
	///
	/// The directory's open error, or [`Session::open_file_at`]'s.
	pub async fn open(&mut self, path: &Path) -> io::Result<File> {
		let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
			return self.session.open_file(path).await.map(|(file, _)| file);
		};
		if self.dir.is_none() || self.dir_path.as_os_str() != parent.as_os_str() {
			self.dir = None;
			let dir = self.session.open_dir(parent).await?;
			self.dir_path.clear();
			self.dir_path.push(parent);
			self.dir = Some(dir);
		}
		let dir = self.dir.as_ref().expect("opened above");
		self
			.session
			.open_file_at(dir, name.as_encoded_bytes(), true)
			.await
			.map(|(file, _)| file)
	}
}

async fn list_with(
	imp: &mut Imp,
	dir: &Dir,
	detail: Detail,
	children: u32,
	out: &mut Listing,
) -> io::Result<()> {
	out.clear();
	match (imp, &dir.repr) {
		(Imp::Native(s), DirRepr::Native(h)) => native::list(s, h, detail, children, out),
		(Imp::Provider(fs), DirRepr::Provider(path)) => provider::list(fs, path, detail, out).await,
		_ => Err(foreign_dir()),
	}
}

/// Test seam between a listing and the calls that follow it: a test registers
/// a closure for an entry name, and the first open (or, registered for it,
/// stat) of an entry by that name runs it just before the call, so the test
/// can swap the entry for a symlink exactly there, without a racing writer.
#[cfg(test)]
pub(crate) mod seam {
	use std::path::Path;

	use parking_lot::Mutex;

	/// How the call that ran a hook reaches its entry.
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub(crate) enum Open {
		/// An open by absolute path.
		Path,
		/// An open relative to the directory it was listed from.
		At,
		/// An open below the walk root, with no symlink followed on the way.
		Beneath,
		/// A stat by path; only [`before_stat`] hooks run here.
		Stat,
	}

	type Hook = Box<dyn FnOnce(Open) + Send>;

	/// Hooks by entry name, and whether they wait for a stat.
	static HOOKS: Mutex<Vec<(Vec<u8>, bool, Hook)>> = Mutex::new(Vec::new());

	/// Runs `hook` just before the first open of an entry named `name`.
	#[cfg_attr(not(unix), expect(dead_code, reason = "only the Unix swap tests register hooks"))]
	pub(crate) fn before_open(name: &str, hook: impl FnOnce(Open) + Send + 'static) {
		HOOKS
			.lock()
			.push((name.as_bytes().to_vec(), false, Box::new(hook)));
	}

	/// Runs `hook` just before the first stat of an entry named `name`.
	#[cfg_attr(not(unix), expect(dead_code, reason = "only the Unix swap tests register hooks"))]
	pub(crate) fn before_stat(name: &str, hook: impl FnOnce(Open) + Send + 'static) {
		HOOKS
			.lock()
			.push((name.as_bytes().to_vec(), true, Box::new(hook)));
	}

	/// Runs (once) the hook registered for `name` and this kind of call, if
	/// any.
	pub(crate) fn fire(name: &[u8], open: Open) {
		let stat = open == Open::Stat;
		let hook = {
			let mut hooks = HOOKS.lock();
			let found = hooks
				.iter()
				.position(|(hooked, on_stat, _)| hooked == name && *on_stat == stat);
			found.map(|index| hooks.swap_remove(index).2)
		};
		if let Some(hook) = hook {
			hook(open);
		}
	}

	/// The final component of `path`.
	pub(crate) fn last(path: &Path) -> &[u8] {
		path.file_name().map_or(b"", |name| name.as_encoded_bytes())
	}

	/// The final component of the walk-relative `rel`.
	pub(crate) fn last_of(rel: &[u8]) -> &[u8] {
		rel.rsplit(|&b| super::is_rel_separator(b))
			.next()
			.unwrap_or(rel)
	}
}

#[cfg(test)]
mod tests;
