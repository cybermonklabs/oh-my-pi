//! Windows directory reads:
//!
//! - Children open with `NtCreateFile` relative to the parent's handle
//!   (`OBJECT_ATTRIBUTES.RootDirectory`) and the raw entry name: no Win32 path
//!   parsing, no DOS-to-NT path conversion, no per-component re-traversal from
//!   the drive root, and no `MAX_PATH` limit. Files read through a directory
//!   handle open the same way.
//! - Listings use `NtQueryDirectoryFile` with `FileDirectoryInformation`, the
//!   smallest class that carries attributes, size, and mtime, so Full detail
//!   costs nothing extra and each call returns as many entries as possible.
//! - Names convert from UTF-16 straight into the listing arena as WTF-8, which
//!   round-trips unpaired surrogates back to the exact on-disk name.
//! - Stats of an absolute path use `NtQueryFullAttributesFile` (a reparse
//!   point's target under `follow`: a handle opened by path), which stamp
//!   `ChangeTime` as a handle's query does, so the listing cache compares like
//!   with like. A file that refuses them falls back to `std::fs`.
//!
//! Reparse points (symlinks, junctions, mount points, cloud placeholders) are
//! reported as symlinks and never descended. Opens that do not follow them
//! (a child directory, a listed file, a path below a walk root) open one
//! component at a time relative to the directory before it with
//! `FILE_OPEN_REPARSE_POINT`, which opens a reparse point itself instead of
//! its target; file opens and opens below a walk root then refuse a reparse
//! point they reached.

use std::{
	io,
	os::windows::{
		fs::{MetadataExt, OpenOptionsExt},
		io::{AsRawHandle, FromRawHandle, OwnedHandle},
	},
	path::Path,
	ptr::{null, null_mut},
};

use windows_sys::{
	Wdk::{
		Foundation::OBJECT_ATTRIBUTES,
		Storage::FileSystem::{
			FILE_DIRECTORY_FILE, FILE_NETWORK_OPEN_INFORMATION, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
			FILE_OPEN_FOR_BACKUP_INTENT, FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT,
			FILE_SYNCHRONOUS_IO_NONALERT, FileDirectoryInformation, FileNetworkOpenInformation,
			NtCreateFile, NtQueryDirectoryFile, NtQueryFullAttributesFile, NtQueryInformationFile,
		},
	},
	Win32::{
		Foundation::{
			ERROR_ACCESS_DENIED, ERROR_DIRECTORY, ERROR_HANDLE_EOF, ERROR_INVALID_DATA,
			ERROR_INVALID_FUNCTION, ERROR_INVALID_NAME, ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED,
			ERROR_SHARING_VIOLATION, ERROR_STOPPED_ON_SYMLINK, HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE,
			RtlNtStatusToDosError, STATUS_NO_MORE_FILES, STATUS_NO_SUCH_FILE, UNICODE_STRING,
		},
		Storage::FileSystem::{
			BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY,
			FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_FLAG_DELETE,
			FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
			FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX, FILE_FLAG_BACKUP_SEMANTICS,
			FILE_FLAG_OPEN_REPARSE_POINT, FILE_INFO_BY_HANDLE_CLASS, FILE_LIST_DIRECTORY,
			FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ,
			FILE_SHARE_WRITE, FILE_WRITE_DATA, FileDispositionInfo, FileDispositionInfoEx,
			GetFileInformationByHandle, GetVolumeInformationByHandleW, ReadFile, SYNCHRONIZE,
			SetFileInformationByHandle,
		},
		System::IO::{IO_STATUS_BLOCK, OVERLAPPED, OVERLAPPED_0, OVERLAPPED_0_0},
	},
};

use super::{aligned_buf, le32, le64, rewrite};
use crate::fs::{
	Detail, FileId, FileInfo, FileType, Listing, Stamp, not_regular,
	wtf8::{push_wide, push_wtf8},
};

/// An open directory or file handle, closed on drop.
pub(crate) type Handle = OwnedHandle;

/// See [`crate::fs::Fs::workers`] (unmeasured on Windows).
pub(crate) const WORKERS: usize = 4;

const LIST_BUF: usize = 64 << 10;

// FILE_DIRECTORY_INFORMATION field offsets.
const FDI_NEXT_ENTRY_OFFSET: usize = 0;
const FDI_LAST_WRITE_TIME: usize = 24;
const FDI_END_OF_FILE: usize = 40;
const FDI_FILE_ATTRIBUTES: usize = 56;
const FDI_FILE_NAME_LENGTH: usize = 60;
const FDI_FILE_NAME: usize = 64;

/// 100ns ticks between 1601-01-01 and 1970-01-01.
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

/// Longest `UNICODE_STRING`, in UTF-16 units.
const MAX_NAME_UNITS: usize = 0x7fff;

const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
/// Lists entries and reads attributes (for stamps).
const DIR_ACCESS: u32 = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const FILE_ACCESS: u32 = FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
/// Truncates and writes a file, and reads attributes to refuse a reparse
/// point first.
const WRITE_ACCESS: u32 = FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
/// Marks an entry for deletion.
const DELETE_ACCESS: u32 = DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

/// Per-session syscall scratch.
#[derive(Default)]
pub(crate) struct Scratch {
	/// Listing buffer (8-aligned, as `NtQueryDirectoryFile` requires).
	buf:   Vec<u64>,
	/// UTF-16 name for NT calls.
	wname: Vec<u16>,
}

fn nt_error(status: NTSTATUS) -> io::Error {
	// SAFETY: a pure status-code conversion.
	io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
}

fn win_error(code: u32) -> io::Error {
	io::Error::from_raw_os_error(code as i32)
}

/// Unix nanoseconds of a FILETIME tick count.
const fn filetime_nanos(ticks: i64) -> i64 {
	ticks.saturating_sub(UNIX_EPOCH_TICKS).saturating_mul(100)
}

const fn info_of(info: &FILE_NETWORK_OPEN_INFORMATION) -> FileInfo {
	let dir = info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
	FileInfo {
		file_type: Some(if dir { FileType::Dir } else { FileType::File }),
		size:      if dir { 0 } else { info.EndOfFile as u64 },
		stamp:     Stamp {
			dev:   0,
			ino:   info.CreationTime as u64,
			mtime: filetime_nanos(info.LastWriteTime),
			ctime: filetime_nanos(info.ChangeTime),
		},
	}
}

/// Opens an absolute path through the Win32 layer, which resolves
/// drive-relative forms, UNC paths, `\\?\` prefixes, and long paths.
fn open_path(path: &Path, access: u32) -> io::Result<Handle> {
	let file = std::fs::OpenOptions::new()
		.access_mode(access)
		.share_mode(SHARE_ALL)
		.custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
		.open(path)?;
	Ok(OwnedHandle::from(file))
}

/// [`open_path`] with `FILE_FLAG_OPEN_REPARSE_POINT`, which opens a reparse
/// point at `path` itself instead of its target.
fn open_path_unlinked(path: &Path, access: u32) -> io::Result<Handle> {
	let file = std::fs::OpenOptions::new()
		.access_mode(access)
		.share_mode(SHARE_ALL)
		.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
		.open(path)?;
	Ok(OwnedHandle::from(file))
}

/// Opens `name` (WTF-8, `/`-separated components) relative to `parent`.
fn nt_open(
	s: &mut Scratch,
	parent: &Handle,
	name: &[u8],
	access: u32,
	options: u32,
) -> io::Result<Handle> {
	nt_create(s, parent, name, access, FILE_OPEN, options)
}

/// Opens (or, as `disposition` says, creates) `name` relative to `parent`.
fn nt_create(
	s: &mut Scratch,
	parent: &Handle,
	name: &[u8],
	access: u32,
	disposition: u32,
	options: u32,
) -> io::Result<Handle> {
	s.wname.clear();
	push_wide(&mut s.wname, name);
	if s.wname.is_empty() || s.wname.len() > MAX_NAME_UNITS {
		return Err(win_error(ERROR_INVALID_NAME));
	}
	let bytes = (s.wname.len() * 2) as u16;
	let us = UNICODE_STRING {
		Length:        bytes,
		MaximumLength: bytes,
		Buffer:        s.wname.as_mut_ptr(),
	};
	let oa = OBJECT_ATTRIBUTES {
		Length:                   size_of::<OBJECT_ATTRIBUTES>() as u32,
		RootDirectory:            parent.as_raw_handle(),
		ObjectName:               &raw const us,
		Attributes:               0,
		SecurityDescriptor:       null(),
		SecurityQualityOfService: null(),
	};
	let mut handle: HANDLE = null_mut();
	let mut iosb = IO_STATUS_BLOCK::default();
	// SAFETY: every pointer refers to a live local or the session's name
	// buffer, which `us` describes exactly.
	let status = unsafe {
		NtCreateFile(
			&raw mut handle,
			access,
			&raw const oa,
			&raw mut iosb,
			null(),
			0,
			SHARE_ALL,
			disposition,
			options | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT,
			null(),
			0,
		)
	};
	if status < 0 {
		return Err(nt_error(status));
	}
	// SAFETY: `NtCreateFile` succeeded and returned a handle this call owns.
	Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// Queries an open handle's attributes, size, and times (reparse points
/// opened without `FILE_OPEN_REPARSE_POINT` report their target).
fn query_handle(h: &Handle) -> io::Result<FILE_NETWORK_OPEN_INFORMATION> {
	let mut info = FILE_NETWORK_OPEN_INFORMATION::default();
	let mut iosb = IO_STATUS_BLOCK::default();
	// SAFETY: `info` is a writable buffer of the size passed.
	let status = unsafe {
		NtQueryInformationFile(
			h.as_raw_handle(),
			&raw mut iosb,
			(&raw mut info).cast(),
			size_of::<FILE_NETWORK_OPEN_INFORMATION>() as u32,
			FileNetworkOpenInformation,
		)
	};
	if status < 0 {
		return Err(nt_error(status));
	}
	Ok(info)
}

/// Stamps an open handle and reports its type and size (reparse points
/// opened without `FILE_OPEN_REPARSE_POINT` report their target).
fn stat_handle(h: &Handle) -> io::Result<FileInfo> {
	query_handle(h).map(|info| info_of(&info))
}

/// Opens `name` (one component) of `parent` with `FILE_OPEN_REPARSE_POINT`,
/// so a reparse point there is opened itself rather than followed, and
/// refuses one (`ERROR_STOPPED_ON_SYMLINK`), as listings report every reparse
/// point as a symlink.
fn nt_open_unlinked(
	s: &mut Scratch,
	parent: &Handle,
	name: &[u8],
	access: u32,
	options: u32,
) -> io::Result<(Handle, FileInfo)> {
	nt_create_unlinked(s, parent, name, access, FILE_OPEN, options)
}

/// [`nt_open_unlinked`] with a create `disposition`.
fn nt_create_unlinked(
	s: &mut Scratch,
	parent: &Handle,
	name: &[u8],
	access: u32,
	disposition: u32,
	options: u32,
) -> io::Result<(Handle, FileInfo)> {
	let h = nt_create(s, parent, name, access, disposition, options | FILE_OPEN_REPARSE_POINT)?;
	let info = query_handle(&h)?;
	if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return Err(win_error(ERROR_STOPPED_ON_SYMLINK));
	}
	Ok((h, info_of(&info)))
}

/// Opens every directory on the way to the last component of the
/// walk-relative `rel` (separated by `/` or `\`) below `root`, one component
/// at a time, following no reparse point ([`nt_open_unlinked`]); returns the
/// directory reached (`None`: `root` itself) and the last component. At most
/// two handles are open at once.
fn parent_beneath<'r>(
	s: &mut Scratch,
	root: &Handle,
	rel: &'r [u8],
) -> io::Result<(Option<Handle>, &'r [u8])> {
	let mut reached: Option<Handle> = None;
	let mut rest = rel;
	while let Some(slash) = memchr::memchr2(b'/', b'\\', rest) {
		let at = reached.as_ref().unwrap_or(root);
		let (dir, _) = nt_open_unlinked(s, at, &rest[..slash], DIR_ACCESS, FILE_DIRECTORY_FILE)?;
		reached = Some(dir);
		rest = &rest[slash + 1..];
	}
	Ok((reached, rest))
}

pub(crate) fn open_dir(_s: &mut Scratch, path: &Path) -> io::Result<Handle> {
	let h = open_path(path, DIR_ACCESS)?;
	// FILE_FLAG_BACKUP_SEMANTICS also opens regular files.
	if stat_handle(&h)?.file_type != Some(FileType::Dir) {
		return Err(win_error(ERROR_DIRECTORY));
	}
	Ok(h)
}

/// Opens the directory at `path` without following a reparse point that is
/// its final component: one there is refused (`ERROR_STOPPED_ON_SYMLINK`),
/// as listings report every reparse point as a symlink.
pub(crate) fn open_dir_unlinked(_s: &mut Scratch, path: &Path) -> io::Result<Handle> {
	let h = open_path_unlinked(path, DIR_ACCESS)?;
	let info = query_handle(&h)?;
	if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return Err(win_error(ERROR_STOPPED_ON_SYMLINK));
	}
	if info_of(&info).file_type != Some(FileType::Dir) {
		return Err(win_error(ERROR_DIRECTORY));
	}
	Ok(h)
}

/// Opens the subdirectory `name` of `parent` without following a reparse
/// point that replaced it since the listing.
pub(crate) fn open_child(s: &mut Scratch, parent: &Handle, name: &[u8]) -> io::Result<Handle> {
	nt_open(s, parent, name, DIR_ACCESS, FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT)
}

const fn is_dot_or_dot_dot_utf16(name: &[u8]) -> bool {
	matches!(name, [b'.', 0] | [b'.', 0, b'.', 0])
}

/// Reads every entry of `dir` into `out`. Sizes and mtimes are always filled
/// because the listing returns them for free.
pub(crate) fn list(
	s: &mut Scratch,
	dir: &Handle,
	_detail: Detail,
	_children: u32,
	out: &mut Listing,
) -> io::Result<()> {
	let buf = aligned_buf(&mut s.buf, LIST_BUF);
	let mut restart = true;
	loop {
		let mut iosb = IO_STATUS_BLOCK::default();
		// SAFETY: `buf` is 8-aligned and writable for the length passed.
		let status = unsafe {
			NtQueryDirectoryFile(
				dir.as_raw_handle(),
				null_mut(),
				None,
				null(),
				&raw mut iosb,
				buf.as_mut_ptr().cast(),
				buf.len() as u32,
				FileDirectoryInformation,
				false,
				null(),
				restart,
			)
		};
		restart = false;
		match status {
			STATUS_NO_MORE_FILES | STATUS_NO_SUCH_FILE => return Ok(()),
			..0 => return Err(nt_error(status)),
			_ => {},
		}
		let n = iosb.Information;
		if n == 0 {
			return Ok(());
		}
		if n > buf.len() {
			return Err(win_error(ERROR_INVALID_DATA));
		}
		let mut off = 0;
		loop {
			if off + FDI_FILE_NAME > n {
				return Err(win_error(ERROR_INVALID_DATA));
			}
			let rec = &buf[off..n];
			let next = le32(rec, FDI_NEXT_ENTRY_OFFSET) as usize;
			let name_len = le32(rec, FDI_FILE_NAME_LENGTH) as usize;
			if !name_len.is_multiple_of(2) || FDI_FILE_NAME + name_len > rec.len() {
				return Err(win_error(ERROR_INVALID_DATA));
			}
			let wname = &rec[FDI_FILE_NAME..FDI_FILE_NAME + name_len];
			if name_len > 0 && !is_dot_or_dot_dot_utf16(wname) {
				let attrs = le32(rec, FDI_FILE_ATTRIBUTES);
				let (file_type, size) = if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
					(FileType::Symlink, None)
				} else if attrs & FILE_ATTRIBUTE_DIRECTORY != 0 {
					(FileType::Dir, None)
				} else {
					(FileType::File, Some(le64(rec, FDI_END_OF_FILE)))
				};
				let mtime = filetime_nanos(le64(rec, FDI_LAST_WRITE_TIME) as i64);
				out.push_with(
					|names| {
						push_wtf8(
							names,
							wname
								.as_chunks::<2>()
								.0
								.iter()
								.map(|&unit| u16::from_le_bytes(unit)),
						);
					},
					file_type,
					size,
					Some(mtime),
					0,
				);
			}
			if next == 0 {
				break;
			}
			if next < FDI_FILE_NAME || off + next > n {
				return Err(win_error(ERROR_INVALID_DATA));
			}
			off += next;
		}
	}
}

/// `h` and its information when it is a regular file (a reparse point opened
/// without `FILE_OPEN_REPARSE_POINT` reports its target).
fn regular(h: Handle) -> io::Result<(Handle, FileInfo)> {
	let info = stat_handle(&h)?;
	file_of((h, info))
}

/// Opens the regular file `name` (one component) in `dir`; without `follow`,
/// a reparse point there is refused ([`nt_open_unlinked`]).
pub(crate) fn open_file_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
	follow: bool,
) -> io::Result<(Handle, FileInfo)> {
	if follow {
		return regular(nt_open(s, dir, name, FILE_ACCESS, 0)?);
	}
	file_of(nt_open_unlinked(s, dir, name, FILE_ACCESS, 0)?)
}

pub(crate) fn open_file(_s: &mut Scratch, path: &Path) -> io::Result<(Handle, FileInfo)> {
	regular(open_path(path, FILE_ACCESS)?)
}

/// Opens the regular file at the walk-relative `rel` below `root`, following
/// no reparse point on the way ([`parent_beneath`]).
pub(crate) fn open_file_beneath(
	s: &mut Scratch,
	root: &Handle,
	rel: &[u8],
) -> io::Result<(Handle, FileInfo)> {
	let (reached, name) = parent_beneath(s, root, rel)?;
	file_of(nt_open_unlinked(s, reached.as_ref().unwrap_or(root), name, FILE_ACCESS, 0)?)
}

/// Opens the directory at the walk-relative `rel` below `root`, following no
/// reparse point on the way ([`parent_beneath`]).
pub(crate) fn open_dir_beneath(s: &mut Scratch, root: &Handle, rel: &[u8]) -> io::Result<Handle> {
	let (reached, name) = parent_beneath(s, root, rel)?;
	let at = reached.as_ref().unwrap_or(root);
	nt_open_unlinked(s, at, name, DIR_ACCESS, FILE_DIRECTORY_FILE).map(|(h, _)| h)
}

/// Rewrites the regular file at the walk-relative `rel` below `root` in place
/// with `contents`, creating it when missing: every directory on the way and
/// the file open without following a reparse point ([`parent_beneath`],
/// [`nt_create_unlinked`]), and the file is truncated only once it is known
/// to be no reparse point and no directory.
pub(crate) fn write_file_beneath(
	s: &mut Scratch,
	root: &Handle,
	rel: &[u8],
	contents: &[u8],
) -> io::Result<()> {
	let (reached, name) = parent_beneath(s, root, rel)?;
	let at = reached.as_ref().unwrap_or(root);
	let (h, _) =
		nt_create_unlinked(s, at, name, WRITE_ACCESS, FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE)?;
	rewrite(std::fs::File::from(h), contents)
}

/// Removes the entry at the walk-relative `rel` below `root`: every directory
/// on the way opens without following a reparse point ([`parent_beneath`]),
/// and the entry, opened itself with `FILE_OPEN_REPARSE_POINT`, is marked for
/// deletion, which happens when its handle closes here. With `dir` the entry
/// must be a directory, a directory symlink or junction included (removed
/// itself, as `RemoveDirectoryW` and [`std::fs::remove_dir`] remove it);
/// without, it must not be one, so a directory symlink or junction fails, as
/// `DeleteFileW` and [`std::fs::remove_file`] fail on it.
///
/// The mark uses POSIX semantics and ignores the read-only attribute, as
/// [`std::fs::remove_file`] does through its `posix_delete`, so a read-only
/// file is removed and its name is freed at once. The same mark serves a
/// directory, so an empty directory with the read-only attribute is removed
/// too, as `rmdir` removes one on Unix, where [`std::fs::remove_dir`]
/// (`RemoveDirectoryW`) refuses it. A file system that does not know that
/// class (`ERROR_INVALID_PARAMETER`, `ERROR_NOT_SUPPORTED`,
/// `ERROR_INVALID_FUNCTION`; FAT, for one) gets the classic mark, as `std`
/// falls back, which refuses a read-only file or directory there as
/// `DeleteFileW` and `RemoveDirectoryW` do.
pub(crate) fn remove_beneath(
	s: &mut Scratch,
	root: &Handle,
	rel: &[u8],
	dir: bool,
) -> io::Result<()> {
	let (reached, name) = parent_beneath(s, root, rel)?;
	let at = reached.as_ref().unwrap_or(root);
	let kind = if dir {
		FILE_DIRECTORY_FILE
	} else {
		FILE_NON_DIRECTORY_FILE
	};
	let h = nt_open(s, at, name, DELETE_ACCESS, kind | FILE_OPEN_REPARSE_POINT)?;
	let posix = FILE_DISPOSITION_INFO_EX {
		Flags: FILE_DISPOSITION_FLAG_DELETE
			| FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
			| FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
	};
	// SAFETY: `FileDispositionInfoEx` takes a `FILE_DISPOSITION_INFO_EX`.
	match unsafe { set_information(&h, FileDispositionInfoEx, &posix) } {
		Err(err)
			if err.raw_os_error().is_some_and(|code| {
				matches!(
					code as u32,
					ERROR_INVALID_PARAMETER | ERROR_NOT_SUPPORTED | ERROR_INVALID_FUNCTION
				)
			}) =>
		{
			let classic = FILE_DISPOSITION_INFO { DeleteFile: true };
			// SAFETY: `FileDispositionInfo` takes a `FILE_DISPOSITION_INFO`.
			unsafe { set_information(&h, FileDispositionInfo, &classic) }
		},
		result => result,
	}
}

/// `SetFileInformationByHandle` of `info` in the class `class` on `h`.
///
/// # Safety
///
/// `T` must be the structure `class` takes.
unsafe fn set_information<T>(
	h: &Handle,
	class: FILE_INFO_BY_HANDLE_CLASS,
	info: &T,
) -> io::Result<()> {
	// SAFETY: `info` is a live `T` of the size passed, which the caller
	// vouches is what `class` takes.
	let ok = unsafe {
		SetFileInformationByHandle(
			h.as_raw_handle(),
			class,
			std::ptr::from_ref(info).cast(),
			size_of::<T>() as u32,
		)
	};
	if ok == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(())
}

/// An opened handle and its information when it is a regular file.
fn file_of((h, info): (Handle, FileInfo)) -> io::Result<(Handle, FileInfo)> {
	if info.file_type != Some(FileType::File) {
		return Err(not_regular());
	}
	Ok((h, info))
}

/// `ReadFile` at offset `off`. The offset rides in an OVERLAPPED, which on a
/// synchronous handle makes the read positional; at end of file such a read
/// fails with `ERROR_HANDLE_EOF` instead of returning 0 bytes.
fn read_raw(h: &Handle, ptr: *mut u8, len: usize, off: u64) -> io::Result<usize> {
	let mut overlapped = OVERLAPPED {
		Anonymous: OVERLAPPED_0 {
			Anonymous: OVERLAPPED_0_0 {
				Offset:     off as u32,
				OffsetHigh: (off >> u32::BITS) as u32,
			},
		},
		..OVERLAPPED::default()
	};
	let mut n = 0u32;
	let want = u32::try_from(len).unwrap_or(u32::MAX).min(1 << 30);
	// SAFETY: `ptr` is writable for `want <= len` bytes per the caller.
	let ok = unsafe { ReadFile(h.as_raw_handle(), ptr, want, &raw mut n, &raw mut overlapped) };
	if ok == 0 {
		let err = io::Error::last_os_error();
		if err.raw_os_error() == Some(ERROR_HANDLE_EOF as i32) {
			return Ok(0);
		}
		return Err(err);
	}
	Ok(n as usize)
}

/// Appends the file's bytes at offset `buf.len()` into `buf`'s spare
/// capacity, up to length `end`; returns the count read (0 at end of file).
pub(crate) fn read_append(h: &Handle, buf: &mut Vec<u8>, end: usize) -> io::Result<usize> {
	let len = buf.len();
	let spare = buf.spare_capacity_mut();
	let want = end.saturating_sub(len).min(spare.len());
	let n = read_raw(h, spare.as_mut_ptr().cast(), want, len as u64)?;
	// SAFETY: `ReadFile` initialized the first `n <= want` spare bytes.
	unsafe { buf.set_len(len + n) };
	Ok(n)
}

/// Reads into `buf` at file offset `off`.
pub(crate) fn read_at(h: &Handle, buf: &mut [u8], off: u64) -> io::Result<usize> {
	read_raw(h, buf.as_mut_ptr(), buf.len(), off)
}

/// Identity of an open file, read from its handle rather than from the path it
/// was opened by.
pub(crate) fn handle_metadata(h: &Handle) -> io::Result<pi_vfs::Metadata> {
	use std::os::windows::io::AsHandle;
	let owned = h.as_handle().try_clone_to_owned()?;
	pi_vfs::Metadata::from_file(&std::fs::File::from(owned))
}

/// Describes the file at `path`. An absolute path is answered by
/// [`full_attributes`], which describes a reparse point itself: without
/// `follow` one is reported as [`FileType::Symlink`]; with `follow` its
/// target is described through a handle opened by path ([`stat_target`]).
/// Those stamps have `ChangeTime` as their `ctime`, as the stamps taken from
/// handles ([`stat_dir`], [`open_file_at`]) have it, which the listing cache
/// compares them with. A file that refuses those queries
/// ([`refuses_queries`]; `C:\hiberfil.sys`, for one) and a relative path are
/// described through `std::fs` instead ([`stat_win32`]), whose stamp has the
/// last write time as its `ctime`.
pub(crate) fn stat(s: &mut Scratch, path: &Path, follow: bool) -> io::Result<FileInfo> {
	if !path.is_absolute() {
		return stat_win32(path, follow);
	}
	let info = match full_attributes(s, path) {
		Ok(info) => info,
		Err(err) if refuses_queries(&err) => return stat_win32(path, follow),
		Err(err) => return Err(err),
	};
	if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		Ok(info_of(&info))
	} else if follow {
		stat_target(path)
	} else {
		Ok(symlink_info(&info))
	}
}

/// The final target of the reparse point at the absolute `path`, described
/// through a handle opened by path following reparse points, as
/// `std::fs::metadata` opens it: a dangling or looping link fails as it fails
/// there. A target still a reparse point once opened (a cloud placeholder) is
/// reported as a symlink, as [`stat_win32`] reports it. A target that refuses
/// the open ([`refuses_queries`]) is described through [`stat_win32`].
fn stat_target(path: &Path) -> io::Result<FileInfo> {
	let h = match open_path(path, FILE_READ_ATTRIBUTES) {
		Ok(h) => h,
		Err(err) if refuses_queries(&err) => return stat_win32(path, true),
		Err(err) => return Err(err),
	};
	let info = query_handle(&h)?;
	if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		Ok(info_of(&info))
	} else {
		Ok(symlink_info(&info))
	}
}

/// A reparse point described by `info`, reported as a symlink.
const fn symlink_info(info: &FILE_NETWORK_OPEN_INFORMATION) -> FileInfo {
	FileInfo { file_type: Some(FileType::Symlink), size: 0, ..info_of(info) }
}

/// Whether `err` is a refusal that `std::fs::metadata` answers from the
/// directory's entry instead (`FindFirstFileExW`): `ERROR_SHARING_VIOLATION`
/// from a system file locked even against attribute reads, or
/// `ERROR_ACCESS_DENIED`.
fn refuses_queries(err: &io::Error) -> bool {
	err.raw_os_error()
		.is_some_and(|code| matches!(code as u32, ERROR_SHARING_VIOLATION | ERROR_ACCESS_DENIED))
}

/// `NtQueryFullAttributesFile` of the absolute `path`, which describes a
/// reparse point (symlink, junction) at `path` itself, not its target.
fn full_attributes(s: &mut Scratch, path: &Path) -> io::Result<FILE_NETWORK_OPEN_INFORMATION> {
	// The NT layer takes names as spelled; Win32 rewriting (`/`, `.`/`..`,
	// trailing dots and spaces) must happen first, as `std::fs` does.
	let normalized;
	let mut bytes = path.as_os_str().as_encoded_bytes();
	if !bytes.starts_with(br"\\?\") && needs_win32_normalizing(bytes) {
		normalized = std::path::absolute(path)?;
		bytes = normalized.as_os_str().as_encoded_bytes();
	}
	s.wname.clear();
	let rest = if let Some(rest) = bytes.strip_prefix(br"\\?\") {
		push_wide(&mut s.wname, br"\??\");
		rest
	} else if let Some(rest) = bytes.strip_prefix(br"\\") {
		push_wide(&mut s.wname, br"\??\UNC\");
		rest
	} else {
		push_wide(&mut s.wname, br"\??\");
		bytes
	};
	push_wide(&mut s.wname, rest);
	if s.wname.len() > MAX_NAME_UNITS {
		return Err(win_error(windows_sys::Win32::Foundation::ERROR_FILENAME_EXCED_RANGE));
	}
	let len = (s.wname.len() * 2) as u16;
	let us = UNICODE_STRING {
		Length:        len,
		MaximumLength: len,
		Buffer:        s.wname.as_mut_ptr(),
	};
	let oa = OBJECT_ATTRIBUTES {
		Length:                   size_of::<OBJECT_ATTRIBUTES>() as u32,
		RootDirectory:            null_mut(),
		ObjectName:               &raw const us,
		Attributes:               OBJ_CASE_INSENSITIVE,
		SecurityDescriptor:       null(),
		SecurityQualityOfService: null(),
	};
	let mut info = FILE_NETWORK_OPEN_INFORMATION::default();
	// SAFETY: `oa` describes the session's name buffer and `info` is a valid
	// out-pointer.
	let status = unsafe { NtQueryFullAttributesFile(&raw const oa, &raw mut info) };
	if status < 0 {
		return Err(nt_error(status));
	}
	Ok(info)
}

/// [`stat`] of a relative path, or of a file that refuses the attribute
/// queries, through `std::fs`, which follows reparse points when `follow` and
/// answers such a file from its directory's entry. Its stamp's `ctime` is the
/// last write time: `std::fs` metadata carries no `ChangeTime`.
fn stat_win32(path: &Path, follow: bool) -> io::Result<FileInfo> {
	let meta = if follow {
		std::fs::metadata(path)?
	} else {
		std::fs::symlink_metadata(path)?
	};
	let attrs = meta.file_attributes();
	let file_type = if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		FileType::Symlink
	} else if attrs & FILE_ATTRIBUTE_DIRECTORY != 0 {
		FileType::Dir
	} else {
		FileType::File
	};
	let mtime = filetime_nanos(meta.last_write_time() as i64);
	Ok(FileInfo {
		file_type: Some(file_type),
		size:      if file_type == FileType::File {
			meta.file_size()
		} else {
			0
		},
		stamp:     Stamp { dev: 0, ino: meta.creation_time(), mtime, ctime: mtime },
	})
}

/// Whether `GetFullPathNameW` would rewrite a non-verbatim path: `/`
/// separators, empty components, `.`/`..` components, or a component
/// ending in a dot or space.
fn needs_win32_normalizing(bytes: &[u8]) -> bool {
	let body = bytes.strip_prefix(br"\\").unwrap_or(bytes);
	body.contains(&b'/')
		|| body.windows(2).any(|pair| pair == br"\\")
		|| body
			.split(|&b| b == b'\\')
			.any(|part| matches!(part.last(), Some(b'.' | b' ')))
}

pub(crate) fn stat_dir(h: &Handle) -> io::Result<Stamp> {
	stat_handle(h).map(|info| info.stamp)
}

/// Opens the path because path queries carry no file index.
pub(crate) fn identify(_s: &mut Scratch, path: &Path) -> io::Result<FileId> {
	identify_dir(&open_path(path, FILE_READ_ATTRIBUTES)?)
}

pub(crate) fn identify_dir(h: &Handle) -> io::Result<FileId> {
	let mut fi = BY_HANDLE_FILE_INFORMATION::default();
	// SAFETY: `fi` is a valid out-pointer.
	if unsafe { GetFileInformationByHandle(h.as_raw_handle(), &raw mut fi) } == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(FileId {
		dev:    u64::from(fi.dwVolumeSerialNumber),
		ino:    (u64::from(fi.nFileIndexHigh) << 32) | u64::from(fi.nFileIndexLow),
		native: true,
	})
}

/// Admits NTFS and `ReFS`, which keep 100ns timestamps and update a
/// directory's write time when its entries change. Path stamps carry no
/// volume identity, so the verdict is not memoized per device.
pub(crate) fn stable_stamps(h: &Handle, _stamp: &Stamp) -> bool {
	let mut name = [0u16; 261];
	// SAFETY: `name` is writable for the length passed; other outputs are
	// not requested.
	let ok = unsafe {
		GetVolumeInformationByHandleW(
			h.as_raw_handle(),
			null_mut(),
			0,
			null_mut(),
			null_mut(),
			null_mut(),
			name.as_mut_ptr(),
			name.len() as u32,
		)
	};
	if ok == 0 {
		return false;
	}
	let name = name.split(|&unit| unit == 0).next().unwrap_or_default();
	["NTFS", "ReFS"]
		.iter()
		.any(|fs| fs.encode_utf16().eq(name.iter().copied()))
}

#[cfg(test)]
mod tests {
	use std::{os::windows::fs::OpenOptionsExt, path::PathBuf};

	use super::{Scratch, full_attributes, refuses_queries, stat};
	use crate::fs::FileType;

	/// A stat of a file that refuses the attribute query falls back to
	/// `std::fs`, which answers it from the directory's entry, with and
	/// without `follow`, as `std::fs::metadata` does. The candidates are a
	/// file this test holds open with share mode 0 and the system files that
	/// are locked even against attribute reads; a candidate that answers the
	/// query is not checked, and when none refused it the test prints UNKNOWN.
	#[test]
	fn a_file_that_refuses_the_attribute_query_is_stated_through_std() {
		let held = std::env::temp_dir().join(format!("pi-walker-locked-{}", std::process::id()));
		std::fs::write(&held, b"held").unwrap();
		let lock = std::fs::OpenOptions::new()
			.read(true)
			.share_mode(0)
			.open(&held)
			.unwrap();
		let mut candidates = vec![held.clone()];
		candidates.extend(
			[r"C:\hiberfil.sys", r"C:\pagefile.sys", r"C:\swapfile.sys", r"D:\pagefile.sys"]
				.map(PathBuf::from),
		);
		let mut s = Scratch::default();
		let (mut reached, mut answered) = (Vec::new(), Vec::new());
		for path in &candidates {
			match full_attributes(&mut s, path) {
				Err(err) if refuses_queries(&err) => {},
				other => {
					answered.push(format!("{}: {:?}", path.display(), other.map(|_| "answered")));
					continue;
				},
			}
			let want = std::fs::symlink_metadata(path).expect("std answers it");
			for follow in [false, true] {
				let info = stat(&mut s, path, follow)
					.unwrap_or_else(|err| panic!("{} (follow {follow}): {err}", path.display()));
				assert_eq!(info.file_type, Some(FileType::File), "{}", path.display());
				assert_eq!(info.size, want.len(), "{}", path.display());
			}
			reached.push(path.display().to_string());
		}
		drop(lock);
		let _ = std::fs::remove_file(&held);
		if reached.is_empty() {
			eprintln!(
				"UNKNOWN: no candidate refused the attribute query ({}); the fallback was not checked",
				answered.join("; ")
			);
		}
	}
}
