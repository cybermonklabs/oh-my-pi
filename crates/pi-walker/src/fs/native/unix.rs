//! Unix descriptors: relative `openat` opens, confined opens below a walk
//! root, positional file reads, and the per-device stable-stamp verdicts.
//! Listing and stat syscalls, and the kernel's own confined open where it has
//! one, come from the platform's `sys` module.

use std::{
	ffi::{c_char, c_int},
	io,
	os::{
		fd::{AsRawFd, OwnedFd, RawFd},
		unix::ffi::OsStrExt,
	},
	path::Path,
};

use parking_lot::RwLock;

use super::{rewrite, sys};
use crate::fs::{Detail, FileId, FileInfo, FileType, Listing, Stamp, not_regular};

/// An open directory or file descriptor, closed on drop.
pub(crate) type Handle = OwnedFd;

/// See [`crate::fs::Fs::workers`].
pub(crate) const WORKERS: usize = sys::WORKERS;

const DIR_FLAGS: c_int = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
/// `O_NONBLOCK`: a FIFO posing as a regular file must not block the open
/// before `fstat` rejects it.
const FILE_FLAGS: c_int = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK;
/// A write-back open: no truncation before `fstat` shows a regular file,
/// `O_NONBLOCK` so a FIFO fails (`ENXIO`) or opens without blocking, and
/// `O_NOCTTY` so a terminal is never adopted.
const WRITE_FLAGS: c_int = libc::O_WRONLY
	| libc::O_CREAT
	| libc::O_CLOEXEC
	| libc::O_NOFOLLOW
	| libc::O_NONBLOCK
	| libc::O_NOCTTY;
/// Mode of a file a write creates, as [`std::fs::File::create`] creates it
/// (less the umask).
const CREATE_MODE: libc::c_uint = 0o666;

/// Largest single read: macOS rejects reads above `INT_MAX` bytes.
const MAX_READ: usize = 0x7fff_f000;

/// Per-session syscall scratch.
#[derive(Default)]
pub(crate) struct Scratch {
	/// Bulk listing buffer (8-aligned).
	pub(super) buf:   Vec<u64>,
	/// NUL-terminated name for `*at` syscalls.
	pub(super) cname: Vec<u8>,
}

impl Scratch {
	/// `name` NUL-terminated in the scratch, valid until the next call.
	pub(super) fn cstr(&mut self, name: &[u8]) -> io::Result<*const c_char> {
		if memchr::memchr(0, name).is_some() {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"));
		}
		self.cname.clear();
		self.cname.extend_from_slice(name);
		self.cname.push(0);
		Ok(self.cname.as_ptr().cast())
	}
}

/// Entry type of a `d_type` value; `None` for special files and `DT_UNKNOWN`.
pub(super) const fn type_of_dt(dt: u8) -> Option<FileType> {
	match dt {
		libc::DT_REG => Some(FileType::File),
		libc::DT_DIR => Some(FileType::Dir),
		libc::DT_LNK => Some(FileType::Symlink),
		_ => None,
	}
}

/// Entry type of an `st_mode`; `None` for special files.
pub(super) const fn type_of_mode(mode: libc::mode_t) -> Option<FileType> {
	match mode & libc::S_IFMT {
		libc::S_IFREG => Some(FileType::File),
		libc::S_IFDIR => Some(FileType::Dir),
		libc::S_IFLNK => Some(FileType::Symlink),
		_ => None,
	}
}

/// Unix nanoseconds of a `(seconds, nanoseconds)` timestamp.
pub(super) const fn nanos(sec: i64, nsec: i64) -> i64 {
	sec.saturating_mul(1_000_000_000).saturating_add(nsec)
}

/// `openat` retrying `EINTR`, for platforms without extra open flags.
#[allow(dead_code, reason = "Linux opens through its own O_NOATIME-aware wrapper")]
pub(super) fn openat_plain(dir: RawFd, path: *const c_char, flags: c_int) -> io::Result<OwnedFd> {
	openat_mode(dir, path, flags, 0)
}

/// `openat` retrying `EINTR`, passing `mode`, which an `O_CREAT` open gives a
/// file it creates (less the umask).
fn openat_mode(
	dir: RawFd,
	path: *const c_char,
	flags: c_int,
	mode: libc::c_uint,
) -> io::Result<OwnedFd> {
	use std::os::fd::FromRawFd;
	loop {
		// SAFETY: `path` is a NUL-terminated string the caller keeps alive, and
		// the mode argument an `O_CREAT` open reads is passed.
		let fd = unsafe { libc::openat(dir, path, flags, mode) };
		if fd >= 0 {
			// SAFETY: `openat` returned a fresh descriptor this call owns.
			return Ok(unsafe { OwnedFd::from_raw_fd(fd) });
		}
		let err = io::Error::last_os_error();
		if err.kind() != io::ErrorKind::Interrupted {
			return Err(err);
		}
	}
}

pub(crate) fn open_dir(s: &mut Scratch, path: &Path) -> io::Result<Handle> {
	let path = s.cstr(path.as_os_str().as_bytes())?;
	sys::openat(libc::AT_FDCWD, path, DIR_FLAGS)
}

/// Opens the subdirectory `name` of `parent` following no symlink there
/// ([`sys::openat_dir`]).
pub(crate) fn open_child(s: &mut Scratch, parent: &Handle, name: &[u8]) -> io::Result<Handle> {
	let name = s.cstr(name)?;
	sys::openat_dir(parent.as_raw_fd(), name, DIR_FLAGS | libc::O_NOFOLLOW)
}

pub(crate) fn list(
	s: &mut Scratch,
	dir: &Handle,
	detail: Detail,
	children: u32,
	out: &mut Listing,
) -> io::Result<()> {
	sys::list(s, dir.as_raw_fd(), detail, children, out)
}

/// Opens the regular file `name` (one component) in `dir`; without `follow`,
/// `O_NOFOLLOW` refuses a symlink there (`ELOOP`).
pub(crate) fn open_file_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
	follow: bool,
) -> io::Result<(Handle, FileInfo)> {
	let name = s.cstr(name)?;
	let flags = if follow {
		FILE_FLAGS
	} else {
		FILE_FLAGS | libc::O_NOFOLLOW
	};
	regular(sys::openat(dir.as_raw_fd(), name, flags)?)
}

pub(crate) fn open_file(s: &mut Scratch, path: &Path) -> io::Result<(Handle, FileInfo)> {
	let path = s.cstr(path.as_os_str().as_bytes())?;
	regular(sys::openat(libc::AT_FDCWD, path, FILE_FLAGS)?)
}

/// Opens the regular file at the walk-relative `rel` below `root`, following
/// no symlink on the way ([`sys::open_beneath`]).
pub(crate) fn open_file_beneath(
	s: &mut Scratch,
	root: &Handle,
	rel: &[u8],
) -> io::Result<(Handle, FileInfo)> {
	regular(sys::open_beneath(s, root.as_raw_fd(), rel, FILE_FLAGS | libc::O_NOFOLLOW)?)
}

/// Opens the directory at the walk-relative `rel` below `root`, following no
/// symlink on the way ([`sys::open_beneath`]).
pub(crate) fn open_dir_beneath(s: &mut Scratch, root: &Handle, rel: &[u8]) -> io::Result<Handle> {
	sys::open_beneath(s, root.as_raw_fd(), rel, DIR_FLAGS | libc::O_NOFOLLOW)
}

/// Rewrites the regular file at the walk-relative `rel` below `root` in place
/// with `contents`, creating it when missing: its directory opens as in
/// [`open_dir_beneath`], the file relative to that directory with
/// `O_NOFOLLOW` (`ELOOP` for a symlink there), and the file is truncated only
/// once `fstat` shows a regular file.
pub(crate) fn write_file_beneath(
	s: &mut Scratch,
	root: &Handle,
	rel: &[u8],
	contents: &[u8],
) -> io::Result<()> {
	let (parent, name) = parent_beneath(s, root, rel)?;
	let at = parent.as_ref().unwrap_or(root).as_raw_fd();
	let name = s.cstr(name)?;
	let (fd, _) = regular(openat_mode(at, name, WRITE_FLAGS, CREATE_MODE)?)?;
	rewrite(std::fs::File::from(fd), contents)
}

/// Removes the entry at the walk-relative `rel` below `root`: its directory
/// opens as in [`open_dir_beneath`], then `unlinkat` relative to that
/// directory removes the entry (an empty directory with `AT_REMOVEDIR` when
/// `dir`), a symlink there itself.
pub(crate) fn remove_beneath(
	s: &mut Scratch,
	root: &Handle,
	rel: &[u8],
	dir: bool,
) -> io::Result<()> {
	let (parent, name) = parent_beneath(s, root, rel)?;
	let at = parent.as_ref().unwrap_or(root).as_raw_fd();
	let name = s.cstr(name)?;
	let flags = if dir { libc::AT_REMOVEDIR } else { 0 };
	// SAFETY: `name` is a NUL-terminated string the scratch keeps alive.
	if unsafe { libc::unlinkat(at, name, flags) } == 0 {
		Ok(())
	} else {
		Err(io::Error::last_os_error())
	}
}

/// The directory holding the last component of the walk-relative `rel`
/// below `root`, opened as in [`open_dir_beneath`] (`None`: `root` itself),
/// and that component.
fn parent_beneath<'r>(
	s: &mut Scratch,
	root: &Handle,
	rel: &'r [u8],
) -> io::Result<(Option<Handle>, &'r [u8])> {
	match memchr::memrchr(b'/', rel) {
		Some(slash) => Ok((Some(open_dir_beneath(s, root, &rel[..slash])?), &rel[slash + 1..])),
		None => Ok((None, rel)),
	}
}

/// [`open_file_beneath`] (`dir` false; the handle is not yet checked to be a
/// regular file) or [`open_dir_beneath`] through the portable
/// [`walk_beneath`] whatever the kernel offers, so tests cover both paths.
#[cfg(test)]
pub(crate) fn open_beneath_walking(
	s: &mut Scratch,
	root: &Handle,
	rel: &[u8],
	dir: bool,
) -> io::Result<Handle> {
	let flags = if dir { DIR_FLAGS } else { FILE_FLAGS };
	walk_beneath(s, root.as_raw_fd(), rel, flags | libc::O_NOFOLLOW)
}

/// Opens `rel` (`/`-separated names, none empty, `.` or `..`) below `dir` one
/// component at a time: each directory on the way, and the last component
/// when `flags` carry `O_DIRECTORY`, with [`sys::openat_dir`] relative to the
/// one before, which opens no symlink (`ENOTDIR`); a last component that is
/// not a directory with `flags`, which carry `O_NOFOLLOW` (`ELOOP` for a
/// symlink). At most two descriptors are open at once, the directory reached
/// and the next one.
pub(super) fn walk_beneath(
	s: &mut Scratch,
	dir: RawFd,
	rel: &[u8],
	flags: c_int,
) -> io::Result<OwnedFd> {
	let mut reached: Option<OwnedFd> = None;
	let mut rest = rel;
	while let Some(slash) = memchr::memchr(b'/', rest) {
		let name = s.cstr(&rest[..slash])?;
		let at = reached.as_ref().map_or(dir, AsRawFd::as_raw_fd);
		reached = Some(sys::openat_dir(at, name, DIR_FLAGS | libc::O_NOFOLLOW)?);
		rest = &rest[slash + 1..];
	}
	let name = s.cstr(rest)?;
	let at = reached.as_ref().map_or(dir, AsRawFd::as_raw_fd);
	if flags & libc::O_DIRECTORY != 0 {
		sys::openat_dir(at, name, flags)
	} else {
		sys::openat(at, name, flags)
	}
}

/// `fd` and its metadata when it is a regular file.
fn regular(fd: OwnedFd) -> io::Result<(Handle, FileInfo)> {
	let info = sys::stat_fd(fd.as_raw_fd())?;
	if info.file_type != Some(FileType::File) {
		return Err(not_regular());
	}
	Ok((fd, info))
}

/// Appends the file's bytes at offset `buf.len()` into `buf`'s spare
/// capacity, up to length `end`; returns the count read (0 at end of file).
pub(crate) fn read_append(h: &Handle, buf: &mut Vec<u8>, end: usize) -> io::Result<usize> {
	let len = buf.len();
	let spare = buf.spare_capacity_mut();
	let want = end.saturating_sub(len).min(spare.len()).min(MAX_READ);
	// SAFETY: `pread` writes at most `want <= spare.len()` bytes into `spare`.
	let n =
		unsafe { libc::pread(h.as_raw_fd(), spare.as_mut_ptr().cast(), want, len as libc::off_t) };
	let n = usize::try_from(n).map_err(|_| io::Error::last_os_error())?;
	// SAFETY: `pread` initialized the first `n <= want` spare bytes.
	unsafe { buf.set_len(len + n) };
	Ok(n)
}

/// Reads into `buf` at file offset `off`.
pub(crate) fn read_at(h: &Handle, buf: &mut [u8], off: u64) -> io::Result<usize> {
	let want = buf.len().min(MAX_READ);
	// SAFETY: `buf` is writable for `want` bytes.
	let n = unsafe { libc::pread(h.as_raw_fd(), buf.as_mut_ptr().cast(), want, off as libc::off_t) };
	usize::try_from(n).map_err(|_| io::Error::last_os_error())
}

/// Identity of an open file, read from its descriptor rather than from the
/// path it was opened by.
pub(crate) fn handle_metadata(h: &Handle) -> io::Result<pi_vfs::Metadata> {
	use std::os::fd::AsFd;
	let owned = h.as_fd().try_clone_to_owned()?;
	pi_vfs::Metadata::from_file(&std::fs::File::from(owned))
}

pub(crate) fn stat(s: &mut Scratch, path: &Path, follow: bool) -> io::Result<FileInfo> {
	let path = s.cstr(path.as_os_str().as_bytes())?;
	sys::stat_path(path, follow)
}

pub(crate) fn stat_dir(h: &Handle) -> io::Result<Stamp> {
	sys::stat_fd(h.as_raw_fd()).map(|info| info.stamp)
}

pub(crate) fn identify(s: &mut Scratch, path: &Path) -> io::Result<FileId> {
	stat(s, path, true).map(|info| id_of(&info.stamp))
}

pub(crate) fn identify_dir(h: &Handle) -> io::Result<FileId> {
	stat_dir(h).map(|stamp| id_of(&stamp))
}

const fn id_of(stamp: &Stamp) -> FileId {
	FileId { dev: stamp.dev, ino: stamp.ino, native: true }
}

/// Stable-stamp verdicts per device: stamps carry real device numbers, so a
/// filesystem is classified once per process.
static STABLE: RwLock<Vec<(u64, bool)>> = RwLock::new(Vec::new());

pub(crate) fn stable_stamps(h: &Handle, stamp: &Stamp) -> bool {
	if let Some(&(_, ok)) = STABLE.read().iter().find(|(dev, _)| *dev == stamp.dev) {
		return ok;
	}
	let ok = sys::fine_timestamps(h.as_raw_fd());
	let mut memo = STABLE.write();
	if !memo.iter().any(|(dev, _)| *dev == stamp.dev) {
		memo.push((stamp.dev, ok));
	}
	ok
}
