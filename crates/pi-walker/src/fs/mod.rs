//! Filesystem layer every walk and search reads through: directory listings,
//! file contents, and change stamps.
//!
//! [`Fs::Native`] is the host filesystem; [`Fs::Provider`] is a
//! [`pi_vfs::Fs`] provider, such as an in-memory tree or a `scheme://` URL
//! namespace. Both reach their directories through [`pi_vfs::DirHandle`]:
//! a descriptor or handle on the host, with the per-platform fast paths of
//! [`pi_vfs::dir_handle`], and the directory's path on a provider. Walkers,
//! ignore loading, the listing cache, and the searches only ever talk to an
//! [`Fs`], so no tool bypasses the layer with its own I/O.
//!
//! Work happens on a [`Session`]: per-thread listing scratch that makes
//! steady-state listing and stat calls allocation-free (the host syscall
//! scratch is per thread in `pi_vfs`). Walkers hold one session per worker.
//! Directories are opened once ([`Session::open_dir`], then
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
//! ancestors' ignore files), open by path; a root that a walk which does not
//! follow symlinks checked with `lstat` opens without following a symlink
//! that is its final component ([`Session::open_dir_unlinked`]).
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

mod root;

use std::{
	io,
	path::{Path, PathBuf},
};

pub use pi_vfs::dir_handle::{
	Detail, FileInfo, FileType, Listing, Record, Stamp, is_not_regular, is_rel_separator,
	is_symlink_refusal,
};
use pi_vfs::{
	DirHandle,
	dir_handle::{HostFile, RegularFile, host, not_regular, os_name},
};
pub use root::{absolute, canonical, resolve_dir};

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

impl From<pi_vfs::FileId> for FileId {
	fn from(id: pi_vfs::FileId) -> Self {
		Self { dev: id.dev(), ino: id.ino(), native: id.is_native() }
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
			Self::Native => Imp::Native,
			Self::Provider(fs) => Imp::Provider(fs.clone()),
		};
		Session { listing: Listing::default(), imp }
	}

	/// Parallelism past which concurrent listing costs more than it gains:
	/// 4 on macOS (APFS contention), 8 on Linux, 4 elsewhere and for
	/// providers.
	pub const fn workers(&self) -> usize {
		match self {
			Self::Native => pi_vfs::dir_handle::WORKERS,
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

/// An open directory: a [`pi_vfs::DirHandle`], which holds a descriptor or
/// handle (host, closed on drop) or the directory's path (provider).
#[derive(Debug)]
pub struct Dir {
	handle: DirHandle,
}

impl Dir {
	/// Whether this directory holds an open descriptor or handle (native),
	/// as opposed to a provider path.
	pub(crate) const fn holds_descriptor(&self) -> bool {
		self.handle.is_native()
	}
}

/// An open regular file, read with [`File::read_into`] or streamed through
/// [`File::read`]. Closed on drop.
#[derive(Debug)]
pub struct File {
	repr: RegularFile,
	size: u64,
	/// Stream position of [`File::read`].
	pos:  u64,
}

impl File {
	fn new((repr, info): (RegularFile, FileInfo)) -> (Self, FileInfo) {
		(Self { repr, size: info.size, pos: 0 }, info)
	}

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
			RegularFile::Host(handle) => {
				fill(buf, self.size, limit, |buf, end| handle.read_append(buf, end))
			},
			RegularFile::Vfs(file) => {
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
	handle: &'a HostFile,
	pos:    &'a mut u64,
}

impl io::Read for NativeReader<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let n = self.handle.read_at(buf, *self.pos)?;
		*self.pos += n as u64;
		Ok(n)
	}
}

impl File {
	/// Reads the next bytes of the file into `buf`, returning the count (0 at
	/// end of file).
	pub async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let n = match &mut self.repr {
			RegularFile::Host(handle) => handle.read_at(buf, self.pos)?,
			RegularFile::Vfs(file) => file.read_async(buf).await?,
		};
		self.pos += n as u64;
		Ok(n)
	}

	/// A synchronous reader continuing at the stream position, for native
	/// files (plain syscalls, like every native operation); `None` for
	/// provider files, which are only read asynchronously.
	pub const fn native_reader(&mut self) -> Option<NativeReader<'_>> {
		match &self.repr {
			RegularFile::Host(handle) => Some(NativeReader { handle, pos: &mut self.pos }),
			RegularFile::Vfs(_) => None,
		}
	}

	/// The identity of the open file, read from the handle rather than from
	/// the path it was opened by: a name replaced after the open still reports
	/// the file that was opened.
	///
	/// # Errors
	///
	/// The handle's (or provider's) status query.
	///
	/// A provider file's query blocks the calling thread: async code calls
	/// [`File::metadata_async`].
	pub fn metadata(&self) -> io::Result<pi_vfs::Metadata> {
		match &self.repr {
			RegularFile::Host(handle) => handle.metadata(),
			RegularFile::Vfs(file) => file.metadata(),
		}
	}

	/// The open file as a [`pi_vfs::File`], for readers built on `pi_vfs`:
	/// the same open file (no reopen by path). A native file reads from its
	/// start, a provider file from where this file's reads left it.
	pub fn into_vfs(self) -> pi_vfs::File {
		match self.repr {
			RegularFile::Host(handle) => pi_vfs::File::from(handle.into_std()),
			RegularFile::Vfs(file) => file,
		}
	}

	/// [`File::metadata`] for async code: a provider file is asked through its
	/// async API, so the query neither holds a runtime worker nor panics on a
	/// current-thread runtime.
	///
	/// # Errors
	///
	/// As for [`File::metadata`].
	pub async fn metadata_async(&self) -> io::Result<pi_vfs::Metadata> {
		match &self.repr {
			RegularFile::Host(handle) => handle.metadata(),
			RegularFile::Vfs(file) => file.metadata_async().await,
		}
	}
}

/// Per-thread filesystem operations. Slices returned by a method stay valid
/// until the next call of the same method.
pub struct Session {
	listing: Listing,
	imp:     Imp,
}

enum Imp {
	Native,
	Provider(pi_vfs::Fs),
}

/// A directory from another kind of [`Fs`] than the session's.
fn foreign_dir() -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, "directory belongs to another filesystem")
}

impl Session {
	/// `dir`'s handle when `dir` comes from this session's kind of [`Fs`].
	fn own<'d>(&self, dir: &'d Dir) -> io::Result<&'d DirHandle> {
		if dir.handle.is_native() == matches!(self.imp, Imp::Native) {
			Ok(&dir.handle)
		} else {
			Err(foreign_dir())
		}
	}

	/// Opens the directory at an absolute path, following symlinks.
	pub async fn open_dir(&mut self, path: &Path) -> io::Result<Dir> {
		#[cfg(test)]
		seam::dir_open(seam::last(path), seam::Open::Path)?;
		let handle = match &self.imp {
			Imp::Native => host::open_dir(path, true)?,
			Imp::Provider(fs) => fs.open_dir_by_path(path, true).await?,
		};
		Ok(Dir { handle })
	}

	/// Opens the directory at an absolute path without following a symlink
	/// that is its final component, as [`Self::open_child`] opens a listed
	/// one: a symlink there is refused (`ENOTDIR` on Unix), even on a kernel
	/// that follows it despite `O_NOFOLLOW`. Earlier components are followed.
	pub async fn open_dir_unlinked(&mut self, path: &Path) -> io::Result<Dir> {
		#[cfg(test)]
		seam::dir_open(seam::last(path), seam::Open::Path)?;
		let handle = match &self.imp {
			Imp::Native => host::open_dir(path, false)?,
			Imp::Provider(fs) => fs.open_dir_by_path(path, false).await?,
		};
		Ok(Dir { handle })
	}

	/// Opens the subdirectory `name` of `parent` without following a symlink
	/// that replaced it since `parent` was listed.
	pub async fn open_child(&mut self, parent: &Dir, name: &[u8]) -> io::Result<Dir> {
		#[cfg(test)]
		seam::dir_open(name, seam::Open::At)?;
		let handle = self.own(parent)?.open_dir_at_async(&os_name(name)).await?;
		Ok(Dir { handle })
	}

	/// Opens the directory `..` of `child`, which is its parent only while
	/// `child` has not moved: callers check the identity of what they get.
	/// Fails with [`io::ErrorKind::Unsupported`] where `..` cannot be opened
	/// relative to a handle (Windows, providers).
	pub(crate) fn open_parent(&self, child: &Dir) -> io::Result<Dir> {
		#[cfg(test)]
		seam::dir_open(b"..", seam::Open::Parent)?;
		let handle = self.own(child)?.open_parent()?;
		Ok(Dir { handle })
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
		let handle = self.own(dir)?;
		handle
			.list_into_async(detail, children, &mut self.listing)
			.await?;
		Ok(&self.listing)
	}

	/// [`Self::list`] into a caller-owned listing (cleared first), so callers
	/// can keep it while using the session again.
	pub(crate) async fn list_into(
		&self,
		dir: &Dir,
		detail: Detail,
		children: u32,
		out: &mut Listing,
	) -> io::Result<()> {
		self.own(dir)?.list_into_async(detail, children, out).await
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
		let handle = self.own(dir)?;
		Ok(File::new(handle.open_regular_at_async(&os_name(name), follow).await?))
	}

	/// Opens the regular file at the walk-relative `rel` (`/`-separated raw
	/// names, none of them empty, `.`, or `..`; on Windows `\` separates them
	/// too) below the open directory `root`, following no symlink on the way:
	/// neither the file nor any directory between `root` and it, also one
	/// swapped in since the listing. This is how a walk that does not follow
	/// symlinks opens a file whose listing carries no directory handle; see
	/// [`DirHandle::open_regular_beneath_async`] for how each side holds it.
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
		#[cfg(test)]
		seam::fire(seam::last_of(rel), seam::Open::Beneath);
		let handle = self.own(root)?;
		Ok(File::new(handle.open_regular_beneath_async(rel).await?))
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
		#[cfg(test)]
		seam::dir_open(seam::last_of(rel), seam::Open::Beneath)?;
		let handle = self.own(root)?.open_dir_beneath_async(rel).await?;
		Ok(Dir { handle })
	}

	/// Replaces the contents of the regular file at the walk-relative `rel`
	/// below the open directory `root` with `contents`, creating the file
	/// when it is missing, and follows no symlink on the way or at the file;
	/// see [`DirHandle::write_beneath_async`]. This is how a walk that does
	/// not follow symlinks writes back a file it listed.
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
		self.own(root)?.write_beneath_async(rel, contents).await
	}

	/// Removes the file, symlink, or special file at the walk-relative `rel`
	/// below the open directory `root`, following no symlink on the way: the
	/// entry removed is below `root` or nothing is, also when a directory on
	/// the way was replaced by a symlink since the listing. A symlink at
	/// `rel` is removed itself, as `unlink` removes it; on Windows a
	/// directory symlink or junction is a directory, which this call refuses
	/// as [`std::fs::remove_file`] refuses it there, and
	/// [`Self::remove_dir_beneath`] removes. This is how a walk that does not
	/// follow symlinks removes an entry it listed; see
	/// [`DirHandle::remove_beneath_async`].
	///
	/// # Errors
	///
	/// [`io::ErrorKind::InvalidInput`] for a `rel` that is not walk-relative,
	/// the refusal of a symlink on the way, and the removal's own errors (a
	/// directory at `rel` fails, as [`std::fs::remove_file`] fails).
	pub async fn remove_file_beneath(&mut self, root: &Dir, rel: &[u8]) -> io::Result<()> {
		self.own(root)?.remove_beneath_async(rel, false).await
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
		self.own(root)?.remove_beneath_async(rel, true).await
	}

	/// Opens the regular file at an absolute path, following symlinks, and
	/// describes it; fails like [`Self::open_file_at`].
	pub async fn open_file(&mut self, path: &Path) -> io::Result<(File, FileInfo)> {
		#[cfg(test)]
		seam::fire(seam::last(path), seam::Open::Path);
		let opened = match &self.imp {
			Imp::Native => host::open_regular(path)?,
			Imp::Provider(fs) => {
				// The type is checked before opening so directories and
				// special files are never opened.
				let info = FileInfo::of(&fs.metadata(path).await?);
				if info.file_type != Some(FileType::File) {
					return Err(not_regular());
				}
				(RegularFile::Vfs(fs.open(path).await?), info)
			},
		};
		Ok(File::new(opened))
	}

	/// Describes the file or directory at an absolute path, following a final
	/// symlink only when `follow` is set.
	pub async fn stat(&mut self, path: &Path, follow: bool) -> io::Result<FileInfo> {
		#[cfg(test)]
		seam::fire(seam::last(path), seam::Open::Stat);
		match &self.imp {
			Imp::Native => host::file_info(path, follow),
			Imp::Provider(fs) => {
				let meta = if follow {
					fs.metadata(path).await?
				} else {
					fs.symlink_metadata(path).await?
				};
				Ok(FileInfo::of(&meta))
			},
		}
	}

	/// Stamps an open directory.
	pub async fn stat_dir(&mut self, dir: &Dir) -> io::Result<Stamp> {
		self.own(dir)?.stamp_async().await
	}

	/// Identity of the file or directory at an absolute path, following
	/// symlinks. Walkers compare identities to stop symlink cycles and to
	/// stay on one filesystem.
	pub async fn identify(&mut self, path: &Path) -> io::Result<FileId> {
		match &self.imp {
			Imp::Native => host::identify(path).map(FileId::from),
			Imp::Provider(fs) => fs.file_id(path, true).await.map(FileId::from),
		}
	}

	/// Identity of an open directory.
	pub async fn identify_dir(&mut self, dir: &Dir) -> io::Result<FileId> {
		self.own(dir)?.identity_async().await.map(FileId::from)
	}

	/// Whether every change to a directory on `dir`'s filesystem (whose stamp
	/// is `stamp`) yields a different stamp: timestamps are fine-grained and
	/// maintained locally (APFS; ext4, XFS, Btrfs, tmpfs, F2FS, ZFS,
	/// bcachefs; NTFS, `ReFS`). Always false for providers. Listing caches rely
	/// on it.
	pub fn stable_stamps(&mut self, dir: &Dir, stamp: &Stamp) -> bool {
		if !matches!(self.imp, Imp::Native) {
			return false;
		}
		let Ok(dir) = self.own(dir) else {
			return false;
		};
		let stable = dir.stable_stamps(stamp);
		// The real check first: only a filesystem it refuses reaches the
		// tests' seam ([`seam::trust_stamps`]).
		#[cfg(test)]
		let stable = stable || seam::trusts_stamps(stamp.dev);
		stable
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

/// Test seam between a listing and the calls that follow it: a test registers
/// a closure for an entry name, and the first open (or, registered for it,
/// stat) of an entry by that name runs it just before the call, so the test
/// can swap the entry for a symlink exactly there, without a racing writer.
/// A test can also make every directory open on its own thread fail
/// ([`fail_opens`]), as a short burst of `EMFILE` would, and have the listing
/// cache trust the stamps of a filesystem ([`trust_stamps`]).
#[cfg(test)]
pub(crate) mod seam {
	use std::{cell::RefCell, io, path::Path};

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
		/// An open of a directory's `..`.
		Parent,
		/// A stat by path; only [`before_stat`] hooks run here.
		Stat,
	}

	type Fail = Box<dyn FnMut(Open) -> Option<io::Error>>;

	thread_local! {
		static FAIL: RefCell<Option<Fail>> = const { RefCell::new(None) };
	}

	/// Fails each directory open on this thread with the error `fail` returns
	/// for its kind, if any, instead of making it, until the returned guard
	/// drops. Thread-local, so tests running beside this one keep their
	/// opens.
	#[cfg_attr(not(unix), expect(dead_code, reason = "only the Unix reopen tests fail opens"))]
	pub(crate) fn fail_opens(fail: impl FnMut(Open) -> Option<io::Error> + 'static) -> Failing {
		FAIL.with_borrow_mut(|slot| *slot = Some(Box::new(fail)));
		Failing
	}

	/// Makes this thread's directory opens again when dropped.
	pub(crate) struct Failing;

	impl Drop for Failing {
		fn drop(&mut self) {
			FAIL.with_borrow_mut(|slot| *slot = None);
		}
	}

	/// Runs the hook registered for `name` and this kind of directory open, if
	/// any, then fails the open when this thread fails such opens.
	pub(crate) fn dir_open(name: &[u8], open: Open) -> io::Result<()> {
		fire(name, open);
		FAIL
			.with_borrow_mut(|slot| slot.as_mut().and_then(|fail| fail(open)))
			.map_or(Ok(()), Err)
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

	/// Devices whose stamps [`super::Session::stable_stamps`] takes as stable
	/// when the real check refuses their filesystem ([`trust_stamps`]).
	static TRUSTED: Mutex<Vec<u64>> = Mutex::new(Vec::new());

	/// Has [`super::Session::stable_stamps`] take the stamps on device `dev`
	/// as stable when the real check refuses its filesystem, as on one it
	/// admits, from now on and in the whole process: a walk stores its
	/// listings on its workers' threads.
	#[cfg_attr(
		not(target_os = "linux"),
		expect(
			dead_code,
			reason = "only a Linux test tree lies on a filesystem the cache refuses by design"
		)
	)]
	pub(crate) fn trust_stamps(dev: u64) {
		let mut trusted = TRUSTED.lock();
		if !trusted.contains(&dev) {
			trusted.push(dev);
		}
	}

	/// Whether [`trust_stamps`] was called for `dev`.
	pub(crate) fn trusts_stamps(dev: u64) -> bool {
		TRUSTED.lock().contains(&dev)
	}
}

#[cfg(test)]
mod tests;
