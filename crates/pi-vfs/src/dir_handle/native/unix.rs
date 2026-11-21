//! Unix descriptors: relative `openat` opens, confined opens below a walk
//! root, positional file reads, the per-device stable-stamp verdicts, and
//! the `*at` calls behind [`crate::DirHandle`]'s general methods. Listing and
//! stat syscalls, and the kernel's own confined open where it has one, come
//! from the platform's `sys` module.

use std::{
	ffi::{CString, c_char, c_int},
	io,
	mem::MaybeUninit,
	os::{
		fd::{AsRawFd, OwnedFd, RawFd},
		unix::ffi::{OsStrExt, OsStringExt},
	},
	path::{Path, PathBuf},
};

use parking_lot::RwLock;

use super::{rewrite, sys};
use crate::{
	dir_handle::{Detail, FileInfo, FileType, Listing, Stamp, not_regular},
	error::nul_in_path,
	metadata::Metadata,
	options::OpenOptions,
	types::{FileId, FileTime, Permissions},
};

/// An open directory or file descriptor, closed on drop.
pub(crate) type Handle = OwnedFd;

/// See [`crate::dir_handle::WORKERS`].
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

#[cfg(test)]
impl Scratch {
	/// Grows the listing buffer to at least `words` 8-byte words, as a
	/// listing grows it.
	pub(crate) fn warm(&mut self, words: usize) {
		self.buf.reserve(words);
	}

	/// The listing buffer's capacity, in 8-byte words.
	pub(crate) fn warmth(&self) -> usize {
		self.buf.capacity()
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

/// Opens the directory at `path` without following a symlink that is its
/// final component ([`sys::openat_dir`]).
pub(crate) fn open_dir_unlinked(s: &mut Scratch, path: &Path) -> io::Result<Handle> {
	let path = s.cstr(path.as_os_str().as_bytes())?;
	sys::openat_dir(libc::AT_FDCWD, path, DIR_FLAGS | libc::O_NOFOLLOW)
}

/// Opens the subdirectory `name` of `parent` following no symlink there
/// ([`sys::openat_dir`]).
pub(crate) fn open_child(s: &mut Scratch, parent: &Handle, name: &[u8]) -> io::Result<Handle> {
	let name = s.cstr(name)?;
	sys::openat_dir(parent.as_raw_fd(), name, DIR_FLAGS | libc::O_NOFOLLOW)
}

/// Opens the directory `..` of `child`: its parent while `child` is where
/// it was listed. The caller checks the result's identity.
pub(crate) fn open_parent(s: &mut Scratch, child: &Handle) -> io::Result<Handle> {
	let dotdot = s.cstr(b"..")?;
	sys::openat_dir(child.as_raw_fd(), dotdot, DIR_FLAGS | libc::O_NOFOLLOW)
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
pub(crate) fn handle_metadata(h: &Handle) -> io::Result<Metadata> {
	use std::os::fd::AsFd;
	let owned = h.as_fd().try_clone_to_owned()?;
	Metadata::from_file(&std::fs::File::from(owned))
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
	FileId::native(stamp.dev, stamp.ino)
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

// The general calls of `DirHandle`: each names one entry of `dir`.

fn cvt(ret: c_int) -> io::Result<()> {
	if ret == -1 {
		Err(io::Error::last_os_error())
	} else {
		Ok(())
	}
}

/// `ret` (0 or -1) of a call retried while it fails with `EINTR`.
fn retry(mut call: impl FnMut() -> c_int) -> io::Result<()> {
	loop {
		match cvt(call()) {
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			result => return result,
		}
	}
}

const fn follow_flag(follow: bool) -> c_int {
	if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW }
}

/// `fstatat` of `name` in `dir`, following a symlink there only with
/// `follow`.
pub(crate) fn stat_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
	follow: bool,
) -> io::Result<Metadata> {
	let name = s.cstr(name)?;
	let mut st = MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `name` is NUL-terminated and `st` is a valid out-pointer.
	retry(|| unsafe { libc::fstatat(dir.as_raw_fd(), name, st.as_mut_ptr(), follow_flag(follow)) })?;
	// SAFETY: `fstatat` succeeded and filled `st`.
	Ok(Metadata::from_stat(unsafe { st.assume_init_ref() }))
}

/// The `open` flags of `options`, as [`std::fs::OpenOptions`] derives them:
/// an access mode, then the creation flags it allows (`EINVAL` for a
/// combination it refuses), then the custom flags past the access mode.
fn open_flags(options: &OpenOptions) -> io::Result<c_int> {
	let invalid = || io::Error::from_raw_os_error(libc::EINVAL);
	let (read, write, append) = (options.is_read(), options.is_write(), options.is_append());
	let access = match (read, write, append) {
		(true, false, false) => libc::O_RDONLY,
		(false, true, false) => libc::O_WRONLY,
		(true, true, false) => libc::O_RDWR,
		(false, _, true) => libc::O_WRONLY | libc::O_APPEND,
		(true, _, true) => libc::O_RDWR | libc::O_APPEND,
		(false, false, false) => return Err(invalid()),
	};
	let (truncate, create, create_new) =
		(options.is_truncate(), options.is_create(), options.is_create_new());
	if !write && !append && (truncate || create || create_new) {
		return Err(invalid());
	}
	if append && truncate && !create_new {
		return Err(invalid());
	}
	let creation = match (truncate, create, create_new) {
		(_, _, true) => libc::O_CREAT | libc::O_EXCL,
		(false, false, false) => 0,
		(true, false, false) => libc::O_TRUNC,
		(false, true, false) => libc::O_CREAT,
		(true, true, false) => libc::O_CREAT | libc::O_TRUNC,
	};
	Ok(access | creation | (options.get_custom_flags() & !libc::O_ACCMODE))
}

/// Opens `name` in `dir` as `options` say, never through a symlink there
/// (`O_NOFOLLOW`: `ELOOP`). A file it creates gets `options`' mode (`0o666`
/// by default) less the process umask; with a creation `mask` it gets
/// exactly that mode less `mask`, as the facades' host opens give it (the
/// mode is set again after an exclusive create; an existing file keeps its
/// mode).
pub(crate) fn open_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
	options: &OpenOptions,
	mask: Option<u32>,
) -> io::Result<std::fs::File> {
	let flags = open_flags(options)? | libc::O_CLOEXEC | libc::O_NOFOLLOW;
	let requested = options.get_mode().unwrap_or(0o666);
	let creates = flags & libc::O_CREAT != 0;
	let name = s.cstr(name)?;
	let Some(mask) = mask.filter(|_| creates) else {
		return openat_mode(dir.as_raw_fd(), name, flags, requested).map(std::fs::File::from);
	};
	let mode = requested & !mask;
	match openat_mode(dir.as_raw_fd(), name, flags | libc::O_EXCL, mode) {
		Ok(fd) => {
			let file = std::fs::File::from(fd);
			// Best effort: without it the file keeps the stricter mode the
			// process umask left.
			let _ = crate::native::file_set_permissions(&file, Permissions::from_mode(mode));
			Ok(file)
		},
		Err(err) if err.kind() == io::ErrorKind::AlreadyExists && flags & libc::O_EXCL == 0 => {
			openat_mode(dir.as_raw_fd(), name, flags, mode).map(std::fs::File::from)
		},
		Err(err) => Err(err),
	}
}

/// `mkdirat` of `name` in `dir` with `mode` (`0o777` by default) less the
/// process umask; with a creation `mask`, exactly `mode` less `mask`, set
/// again after the create on the directory made ([`set_made_dir_mode`]). A
/// symlink or any other non-directory put at the name since `mkdirat` is
/// refused and keeps its mode, and the call fails; a directory renamed in at
/// the name is not told apart and gets the mode. When the mode cannot be
/// set, the call fails, and the directory stays with the mode it was made
/// with.
pub(crate) fn create_dir_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
	mode: Option<u32>,
	mask: Option<u32>,
) -> io::Result<()> {
	#[cfg(test)]
	let entry = name;
	let name = s.cstr(name)?;
	let requested = mode.unwrap_or(0o777);
	let mode = mask.map_or(requested, |mask| requested & !mask) as libc::mode_t;
	// Off Linux the mode is set again through a descriptor that needs the
	// owner's read and search bits, so the directory is made with them too.
	let made = if mask.is_some() && cfg!(not(target_os = "linux")) {
		mode | libc::S_IRWXU
	} else {
		mode
	};
	// SAFETY: `name` is NUL-terminated.
	retry(|| unsafe { libc::mkdirat(dir.as_raw_fd(), name, made) })?;
	#[cfg(test)]
	seams::fire_after_create_dir(entry);
	if mask.is_some() {
		set_made_dir_mode(dir, name, mode)?;
	}
	Ok(())
}

/// Sets `mode` on the directory `name` in `dir`, refusing anything else at
/// the name (`ENOTDIR`), a symlink included: on Linux through an
/// `O_PATH | O_DIRECTORY | O_NOFOLLOW` descriptor, which needs no permission
/// on the directory itself, and `chmod` of its `/proc/self/fd/N`; without
/// `/proc`, and elsewhere, through a read-only descriptor opened as
/// [`open_child`] opens one, and `fchmod`, which needs the owner's read bit
/// (a process umask can clear it).
fn set_made_dir_mode(dir: &Handle, name: *const c_char, mode: libc::mode_t) -> io::Result<()> {
	#[cfg(target_os = "linux")]
	{
		let flags = libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
		let fd = openat_mode(dir.as_raw_fd(), name, flags, 0)?;
		let by_fd = CString::new(format!("{}/self/fd/{}", proc_root(), fd.as_raw_fd()))
			.map_err(|_| nul_in_path())?;
		// SAFETY: `by_fd` is NUL-terminated.
		match retry(|| unsafe { libc::chmod(by_fd.as_ptr(), mode) }) {
			Err(err) if err.kind() == io::ErrorKind::NotFound => {},
			result => return result,
		}
	}
	let fd = sys::openat_dir(dir.as_raw_fd(), name, DIR_FLAGS | libc::O_NOFOLLOW)?;
	// SAFETY: `fd` is an open descriptor.
	retry(|| unsafe { libc::fchmod(fd.as_raw_fd(), mode) })
}

/// Where [`set_made_dir_mode`] finds `/proc`.
#[cfg(all(target_os = "linux", not(test)))]
const fn proc_root() -> &'static str {
	"/proc"
}

/// Where [`set_made_dir_mode`] finds `/proc`; with
/// [`seams::set_mode_without_proc`] on, a path that is not there, as when no
/// `/proc` is mounted.
#[cfg(all(target_os = "linux", test))]
fn proc_root() -> &'static str {
	if seams::mode_without_proc() {
		"/nonexistent-proc"
	} else {
		"/proc"
	}
}

/// `unlinkat` of `name` in `dir`: an empty directory with `dir_entry`, else
/// a file, symlink (itself) or special file.
pub(crate) fn remove_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
	dir_entry: bool,
) -> io::Result<()> {
	let name = s.cstr(name)?;
	let flags = if dir_entry { libc::AT_REMOVEDIR } else { 0 };
	// SAFETY: `name` is NUL-terminated.
	retry(|| unsafe { libc::unlinkat(dir.as_raw_fd(), name, flags) })
}

fn c_name(name: &[u8]) -> io::Result<CString> {
	CString::new(name).map_err(|_| nul_in_path())
}

/// `renameat` of `from` in `dir` to `to` in `to_dir`.
pub(crate) fn rename_at(
	s: &mut Scratch,
	dir: &Handle,
	from: &[u8],
	to_dir: &Handle,
	to: &[u8],
) -> io::Result<()> {
	let to = c_name(to)?;
	let from = s.cstr(from)?;
	// SAFETY: both names are NUL-terminated.
	retry(|| unsafe { libc::renameat(dir.as_raw_fd(), from, to_dir.as_raw_fd(), to.as_ptr()) })
}

/// `symlinkat`: makes `name` in `dir` a symlink holding `target` verbatim.
pub(crate) fn symlink_at(
	s: &mut Scratch,
	dir: &Handle,
	target: &Path,
	name: &[u8],
) -> io::Result<()> {
	let target = c_name(target.as_os_str().as_bytes())?;
	let name = s.cstr(name)?;
	// SAFETY: both strings are NUL-terminated.
	retry(|| unsafe { libc::symlinkat(target.as_ptr(), dir.as_raw_fd(), name) })
}

/// `readlinkat` of `name` in `dir`, growing the buffer until the target
/// fits.
pub(crate) fn read_link_at(s: &mut Scratch, dir: &Handle, name: &[u8]) -> io::Result<PathBuf> {
	let name = s.cstr(name)?;
	let mut buf = Vec::<u8>::with_capacity(256);
	loop {
		// SAFETY: `name` is NUL-terminated and `buf` is writable for its
		// capacity.
		let n = unsafe {
			libc::readlinkat(dir.as_raw_fd(), name, buf.as_mut_ptr().cast(), buf.capacity())
		};
		let Ok(n) = usize::try_from(n) else {
			let err = io::Error::last_os_error();
			if err.kind() == io::ErrorKind::Interrupted {
				continue;
			}
			return Err(err);
		};
		if n < buf.capacity() {
			// SAFETY: `readlinkat` initialized the first `n` bytes.
			unsafe { buf.set_len(n) };
			return Ok(PathBuf::from(std::ffi::OsString::from_vec(buf)));
		}
		// The target may have been cut at the capacity: read again into
		// twice the room (`buf` is empty, so this is the capacity asked).
		buf.reserve(buf.capacity() * 2);
	}
}

/// `fchmodat` of `name` in `dir`; without `follow` a symlink there is not
/// followed: Linux refuses to change one (`EOPNOTSUPP`), macOS changes the
/// link itself. On a Linux glibc before 2.32, whose `fchmodat` refuses
/// `AT_SYMLINK_NOFOLLOW` for every file, a file that is no symlink is
/// changed through an `O_PATH` descriptor of it instead, as glibc 2.32 does.
pub(crate) fn set_permissions_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
	permissions: Permissions,
	follow: bool,
) -> io::Result<()> {
	let name = s.cstr(name)?;
	chmod_at(dir, name, permissions.mode() as libc::mode_t, follow)
}

/// [`set_permissions_at`] on a name already made a C string.
fn chmod_at(dir: &Handle, name: *const c_char, mode: libc::mode_t, follow: bool) -> io::Result<()> {
	// SAFETY: `name` is NUL-terminated.
	let chmod =
		|| retry(|| unsafe { libc::fchmodat(dir.as_raw_fd(), name, mode, follow_flag(follow)) });
	#[cfg(all(test, target_os = "linux"))]
	let changed = if !follow && seams::old_glibc() {
		Err(io::Error::from_raw_os_error(libc::EOPNOTSUPP))
	} else {
		chmod()
	};
	#[cfg(not(all(test, target_os = "linux")))]
	let changed = chmod();
	#[cfg(target_os = "linux")]
	if !follow
		&& let Err(err) = &changed
		&& err.raw_os_error() == Some(libc::EOPNOTSUPP)
	{
		return chmod_unlinked(dir, name, mode);
	}
	changed
}

/// Changes the mode of `name` in `dir` unless it is a symlink (then
/// `EOPNOTSUPP`), through an `O_PATH | O_NOFOLLOW` descriptor of it and its
/// `/proc/self/fd` name: the mode goes to the inode opened, never through a
/// symlink swapped in after the open. Without `/proc` the refusal stands.
#[cfg(target_os = "linux")]
fn chmod_unlinked(dir: &Handle, name: *const c_char, mode: libc::mode_t) -> io::Result<()> {
	let refused = || io::Error::from_raw_os_error(libc::EOPNOTSUPP);
	let fd =
		openat_mode(dir.as_raw_fd(), name, libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0)?;
	let mut st = MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `fd` is open and `st` is a valid out-pointer.
	cvt(unsafe { libc::fstat(fd.as_raw_fd(), st.as_mut_ptr()) })?;
	// SAFETY: `fstat` succeeded and filled `st`.
	if unsafe { st.assume_init_ref() }.st_mode & libc::S_IFMT == libc::S_IFLNK {
		return Err(refused());
	}
	let by_fd = CString::new(format!("/proc/self/fd/{}", fd.as_raw_fd())).map_err(|_| refused())?;
	// SAFETY: `by_fd` is NUL-terminated.
	match retry(|| unsafe { libc::chmod(by_fd.as_ptr(), mode) }) {
		Err(err) if err.kind() == io::ErrorKind::NotFound => Err(refused()),
		result => result,
	}
}

/// `utimensat` of `name` in `dir`: [`FileTime::Omit`] keeps a time,
/// [`FileTime::Now`] takes the filesystem clock; without `follow` a symlink
/// there gets the times itself.
pub(crate) fn set_times_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
	accessed: FileTime,
	modified: FileTime,
	follow: bool,
) -> io::Result<()> {
	let name = s.cstr(name)?;
	let times = [crate::native::timespec(accessed), crate::native::timespec(modified)];
	// SAFETY: `name` is NUL-terminated and `times` holds the two entries
	// `utimensat` reads.
	retry(|| unsafe { libc::utimensat(dir.as_raw_fd(), name, times.as_ptr(), follow_flag(follow)) })
}

/// `fchownat` of `name` in `dir`; `None` keeps that id. Without `follow` a
/// symlink there changes owner itself.
pub(crate) fn chown_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
	uid: Option<u32>,
	gid: Option<u32>,
	follow: bool,
) -> io::Result<()> {
	let name = s.cstr(name)?;
	let uid = uid.map_or(libc::uid_t::MAX, |uid| uid as libc::uid_t);
	let gid = gid.map_or(libc::gid_t::MAX, |gid| gid as libc::gid_t);
	// SAFETY: `name` is NUL-terminated.
	retry(|| unsafe { libc::fchownat(dir.as_raw_fd(), name, uid, gid, follow_flag(follow)) })
}

#[cfg(test)]
pub(crate) use seams::after_create_dir;
#[cfg(all(test, target_os = "linux"))]
pub(crate) use seams::{emulate_old_glibc, set_mode_without_proc};

/// Whether this process may open `name` in `dir` with `mode` (`R_OK`,
/// `W_OK`), by its effective IDs.
pub(crate) fn may_access_at(dir: &Handle, name: &[u8], mode: c_int) -> bool {
	let Ok(name) = CString::new(name) else {
		return false;
	};
	// SAFETY: `name` is NUL-terminated.
	unsafe { libc::faccessat(dir.as_raw_fd(), name.as_ptr(), mode, libc::AT_EACCESS) == 0 }
}

/// A non-blocking open of one end of the FIFO `name` in `dir` (the write end
/// with `write`): it connects to an open of the other end that waits for it,
/// while the caller keeps it. `ENXIO` for a write end no reader waits for
/// yet.
pub(crate) fn touch_fifo_at(dir: &Handle, name: &[u8], write: bool) -> io::Result<OwnedFd> {
	let name = CString::new(name).map_err(|_| nul_in_path())?;
	let access = if write {
		libc::O_WRONLY
	} else {
		libc::O_RDONLY
	};
	let flags = access | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC;
	openat_mode(dir.as_raw_fd(), name.as_ptr(), flags, 0)
}

/// Test seams: a hook between a call's steps, so a test can swap an entry
/// exactly there, an emulated glibc, and a switch that makes the masked
/// mode be set as without `/proc`.
#[cfg(test)]
mod seams {
	use parking_lot::Mutex;

	type Hook = Box<dyn FnOnce() + Send>;

	/// Hooks by entry name.
	static AFTER_CREATE_DIR: Mutex<Vec<(Vec<u8>, Hook)>> = Mutex::new(Vec::new());

	/// Runs `hook` once, just after `create_dir_at` made an entry `name`,
	/// before it sets the mode.
	pub(crate) fn after_create_dir(name: &[u8], hook: impl FnOnce() + Send + 'static) {
		AFTER_CREATE_DIR
			.lock()
			.push((name.to_vec(), Box::new(hook)));
	}

	pub(super) fn fire_after_create_dir(name: &[u8]) {
		let hook = {
			let mut hooks = AFTER_CREATE_DIR.lock();
			let found = hooks.iter().position(|(hooked, _)| hooked == name);
			found.map(|index| hooks.swap_remove(index).1)
		};
		if let Some(hook) = hook {
			hook();
		}
	}

	#[cfg(target_os = "linux")]
	static MODE_WITHOUT_PROC: std::sync::atomic::AtomicBool =
		std::sync::atomic::AtomicBool::new(false);

	/// Makes masked `create_dir_at` calls in this process from now on set
	/// the mode as without `/proc` (`on`): the `chmod` of
	/// `/proc/self/fd/N` names a path that is not there, as when no `/proc`
	/// is mounted.
	#[cfg(target_os = "linux")]
	pub(crate) fn set_mode_without_proc(on: bool) {
		MODE_WITHOUT_PROC.store(on, std::sync::atomic::Ordering::SeqCst);
	}

	#[cfg(target_os = "linux")]
	pub(super) fn mode_without_proc() -> bool {
		MODE_WITHOUT_PROC.load(std::sync::atomic::Ordering::SeqCst)
	}

	#[cfg(target_os = "linux")]
	thread_local! {
		static OLD_GLIBC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
	}

	/// While the returned guard lives, this thread's `fchmodat` with
	/// `AT_SYMLINK_NOFOLLOW` fails with `EOPNOTSUPP` for every file, as glibc
	/// before 2.32 has it.
	#[cfg(target_os = "linux")]
	pub(crate) fn emulate_old_glibc() -> OldGlibc {
		OLD_GLIBC.set(true);
		OldGlibc
	}

	#[cfg(target_os = "linux")]
	pub(crate) struct OldGlibc;

	#[cfg(target_os = "linux")]
	impl Drop for OldGlibc {
		fn drop(&mut self) {
			OLD_GLIBC.set(false);
		}
	}

	#[cfg(target_os = "linux")]
	pub(super) fn old_glibc() -> bool {
		OLD_GLIBC.get()
	}
}
