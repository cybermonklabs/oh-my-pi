//! Copy-on-write file cloning, shared by the tree-cloning backends and the
//! shell's `cp`.
//!
//! A clone shares the source's storage extents until either file is written:
//!
//! | Platform | Primitive | Filesystems |
//! |---|---|---|
//! | Linux, Android | `FICLONE` | btrfs, XFS, bcachefs, OCFS2, … |
//! | macOS | `clonefile(2)` | APFS |
//! | Windows | `FSCTL_DUPLICATE_EXTENTS_TO_FILE` | `ReFS`, Dev Drive |
//!
//! Elsewhere, and between files that cannot share extents (different
//! filesystems, NTFS, ext4, …), [`clone_file`] fails with an error
//! [`is_unsupported`] recognizes; callers then copy the data instead.
//!
//! # Example
//!
//! ```ignore
//! match pi_iso::cow::clone_file(src, dst) {
//!     Ok(_clone) => {},
//!     Err(err) if pi_iso::cow::is_unsupported(&err) => drop(std::fs::copy(src, dst)?),
//!     Err(err) => return Err(err),
//! }
//! ```

use std::{
	fs::{self, File, Metadata},
	io,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

/// Makes `dst` a copy-on-write clone of the regular file `src`, following
/// symlinks at either path, and returns the clone open.
///
/// A caller sets the clone's owner, mode and times through that descriptor,
/// as GNU `cp` sets them on the descriptor it cloned into, so that a name
/// another user swaps for a link after the clone cannot send them elsewhere.
///
/// A missing `dst` is created. Only its data is guaranteed: an APFS clone
/// also carries `src`'s mode, flags, extended attributes, and timestamps,
/// while elsewhere `dst` gets default permissions.
///
/// An existing `dst` with one link is never written in place: the clone is
/// made beside it and renamed over it, so a failed clone leaves `dst`
/// untouched. The swap keeps what an in-place copy keeps: `dst`'s mode and
/// its owner and group (Unix), which is why `dst` must be a writable regular
/// file whose owner the clone can take on. `dst`'s extended attributes and
/// ACL do not survive; on Windows the clone gets the directory's inherited
/// ACL and the caller as owner.
///
/// A `dst` with other hard links cannot be swapped without splitting its
/// names. On Linux it is cloned into itself, as GNU `cp` clones into the
/// file it opened, so every name sees the clone ([`clone_in_place`]); a
/// clone the filesystem refuses (`EOPNOTSUPP`, `EXDEV`, `EINVAL`) leaves its
/// data whole there too. A clone can also fail part way (`ENOSPC` or `EIO`
/// on XFS, which keeps the extents it already shared): then the file holds
/// the new data at its start and its own after it, and the error is
/// reported, where GNU's file would hold only the part cloned. Elsewhere such
/// a `dst` is refused.
///
/// # Errors
///
/// An [`is_unsupported`] error when the files cannot share extents
/// (different filesystems, a filesystem without cloning, an unsupported
/// platform) or `dst` cannot be swapped for a clone; otherwise the failing
/// call. Where the clone itself fails, the error is the system's own, as GNU
/// `cp --reflink=always` reports it: across filesystems the cross-device
/// error, elsewhere what the filesystem answers. On error no clone is left
/// behind and an existing `dst` is unchanged, but for two cases of a `dst`
/// with other hard links: a clone that fails part way leaves the new data at
/// its start (see above), and where it had to be emptied and putting its data
/// back failed too, `dst` is left empty and the error names the file beside
/// it that holds its data.
pub fn clone_file(src: &Path, dst: &Path) -> io::Result<File> {
	let existing = match fs::metadata(dst) {
		Ok(metadata) if metadata.is_file() => Some(metadata),
		Ok(_) => return Err(unsupported("destination is not a regular file")),
		Err(err) if err.kind() == io::ErrorKind::NotFound => None,
		Err(err) => return Err(err),
	};
	match existing {
		None => clone_new(src, dst).map(clone_of),
		// Swap the file a symlinked `dst` names, as an in-place copy writes it.
		Some(metadata) => clone_over(src, &fs::canonicalize(dst)?, &metadata),
	}
}

/// Whether `err` from [`clone_file`] means the files cannot be cloned, as
/// opposed to an I/O failure a data copy would hit too.
pub fn is_unsupported(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::Unsupported {
		return true;
	}
	#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos", windows))]
	{
		err.raw_os_error().is_some_and(imp::is_unsupported_code)
	}
	#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos", windows)))]
	{
		false
	}
}

/// Clones `src`'s data into `dst`, two files the caller already holds open.
///
/// `dst` must be writable and empty (just created or truncated). This is the
/// copy GNU `cp` issues on its open descriptors, without [`clone_file`]'s
/// path lookups, probe file and rename.
///
/// # Errors
///
/// As [`clone_file`]. A failed clone leaves `dst` empty and, on Windows, not
/// sparse, so the caller can copy the data into it instead.
#[cfg(any(target_os = "linux", target_os = "android", windows))]
pub fn clone_open(src: &File, dst: &File) -> io::Result<()> {
	let cloned = imp::clone_into(src, dst);
	#[cfg(windows)]
	if cloned.is_err() {
		// The block clone extends `dst` and makes it sparse before cloning.
		let _ = dst.set_len(0);
		let _ = imp::set_sparse(dst, false);
	}
	cloned
}

/// Whether an [`is_unsupported`] [`clone_open`] error is cross-device.
///
/// Distinguishes files on different devices from a source filesystem that
/// cannot clone: only the latter holds for every later copy from it.
pub fn is_cross_device(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::CrossesDevices
}

#[cfg(target_os = "macos")]
pub(crate) use imp::{CLONE_NOFOLLOW, clonefile};

fn unsupported(reason: &str) -> io::Error {
	io::Error::new(io::ErrorKind::Unsupported, reason)
}

/// The clone of what [`clone_new`] returns.
#[cfg(any(target_os = "linux", target_os = "android", windows))]
fn clone_of((_src, dst): (File, File)) -> File {
	dst
}

#[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
const fn clone_of(dst: File) -> File {
	dst
}

/// Replaces the regular file `dst` (described by `metadata`) with a clone of
/// `src` made beside it, when the swap passes for an in-place copy. The
/// clone takes `dst`'s owner and mode through its own descriptor before the
/// rename, and is returned open. A `dst` with other hard links is cloned
/// into instead ([`clone_in_place`]).
fn clone_over(src: &Path, dst: &Path, metadata: &Metadata) -> io::Result<File> {
	let file = fs::OpenOptions::new()
		.write(true)
		.open(dst)
		.map_err(|_| unsupported("destination is not writable"))?;
	if link_count(&file, metadata)? != 1 {
		return clone_in_place(src, dst, file, metadata);
	}
	drop(file);

	let temp = temp_beside(dst);
	let clone = clone_of(clone_new(src, &temp)?);
	#[cfg(test)]
	AFTER_CLONE.with_borrow_mut(|hook| {
		if let Some(hook) = hook.as_mut() {
			hook(&temp);
		}
	});
	let swapped = (|| {
		#[cfg(unix)]
		take_owner(&clone, metadata)?;
		clone.set_permissions(metadata.permissions())?;
		fs::rename(&temp, dst)
	})();
	if swapped.is_err() {
		let _ = fs::remove_file(&temp);
	}
	swapped.map(|()| clone)
}

/// A name beside `dst` for a temporary file of this module.
fn temp_beside(dst: &Path) -> PathBuf {
	/// Keeps the temporaries of concurrent clones in one process apart.
	static SEQUENCE: AtomicU64 = AtomicU64::new(0);

	dst.with_file_name(format!(
		".cow-clone-{}-{}",
		std::process::id(),
		SEQUENCE.fetch_add(1, Ordering::Relaxed)
	))
}

/// A test's hook at [`AFTER_CLONE`].
#[cfg(test)]
type AfterClone = Box<dyn FnMut(&Path)>;

#[cfg(test)]
thread_local! {
	/// Set by a test on its own thread: 1, the clone into an emptied
	/// destination fails ([`clone_shrinking`]), as one can (`ENOSPC`); 2,
	/// the clone that puts the kept data back fails too, so it is copied
	/// back ([`put_back`]); 3, the copy fails as well.
	pub(crate) static FAIL_AFTER_EMPTYING: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
	/// Set by a test on its own thread: run with the temporary clone's path
	/// in [`clone_over`], after the clone and before it takes `dst`'s owner
	/// and mode, where a test reads what another user could open.
	pub(crate) static AFTER_CLONE: std::cell::RefCell<Option<AfterClone>> = const { std::cell::RefCell::new(None) };
}

/// Clones `src` into the regular file `dst` itself, open for writing as
/// `file` (described by `metadata`), so every hard link of it sees the
/// clone, as GNU `cp` clones into the file it opened; returns `file`.
///
/// GNU truncates the file first and loses its data when the clone then
/// fails. Here the clone is asked for over the old data, which a clone the
/// filesystem refuses leaves whole, and the file is cut to `src`'s length
/// after. The
/// kernel clones a source whose end falls inside a block only up to the
/// destination's own end (`EINVAL` otherwise), so a shorter such source goes
/// through [`clone_shrinking`].
#[cfg(any(target_os = "linux", target_os = "android"))]
fn clone_in_place(src: &Path, dst: &Path, file: File, metadata: &Metadata) -> io::Result<File> {
	let src = File::open(src)?;
	let source = src.metadata()?;
	match imp::clone_into(&src, &file) {
		Ok(()) => {
			file.set_len(source.len())?;
			Ok(file)
		},
		Err(err)
			if err.raw_os_error() == Some(libc::EINVAL)
				&& source.is_file()
				&& source.len() < metadata.len() =>
		{
			clone_shrinking(&src, dst, file, metadata)
		},
		Err(err) => Err(err),
	}
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn clone_in_place(_src: &Path, _dst: &Path, _file: File, _metadata: &Metadata) -> io::Result<File> {
	Err(unsupported("destination has other hard links"))
}

/// [`clone_in_place`] for a source shorter than `dst` that ends inside a
/// block: clones `dst`'s data into a file beside it (a filesystem that
/// cannot clone fails here, with `dst` untouched), empties `dst`, clones
/// `src` into it, and on a failure puts the kept data back.
///
/// The data kept is read through `file` itself, reopened for reading by
/// `/proc/self/fd`, never through the name, which another process could
/// have changed. The kept file is made in `dst`'s own directory, under a
/// name of this process's (`.cow-clone-<pid>-<n>`), with `O_CREAT | O_EXCL`
/// and mode 0600: it replaces nothing that is there, follows no link at its
/// name, and no other user can read the data it holds. It is removed once
/// the data is cloned or put back. Where putting the data back fails too,
/// `dst` is left empty and the kept file is left in place, and the error
/// names it: the old data is never lost. This path needs read access to
/// `dst` and write access to its directory, which GNU does not.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn clone_shrinking(src: &File, dst: &Path, file: File, metadata: &Metadata) -> io::Result<File> {
	use std::os::unix::{
		fs::{MetadataExt as _, OpenOptionsExt as _},
		io::AsRawFd as _,
	};

	// `file` is open for writing only: its data is read through a second
	// descriptor of the same file, which must be the one `metadata` describes.
	let written = file.metadata()?;
	if (written.dev(), written.ino()) != (metadata.dev(), metadata.ino()) {
		return Err(unsupported("destination was replaced during the clone"));
	}
	let current = File::open(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(|err| {
		io::Error::new(
			err.kind(),
			format!(
				"cannot reopen the destination through /proc to keep its data: {}",
				strerror(&err)
			),
		)
	})?;
	let now = current.metadata()?;
	if (now.dev(), now.ino()) != (written.dev(), written.ino()) {
		return Err(unsupported("destination was replaced during the clone"));
	}
	let kept_path = temp_beside(dst);
	let kept = fs::OpenOptions::new()
		.read(true)
		.write(true)
		.create_new(true)
		.mode(0o600)
		.open(&kept_path)?;
	let mut keep = false;
	let result = (|| {
		imp::clone_into(&current, &kept)?;
		file.set_len(0)?;
		#[cfg(test)]
		let cloned = if FAIL_AFTER_EMPTYING.get() >= 1 {
			Err(io::Error::from_raw_os_error(libc::ENOSPC))
		} else {
			imp::clone_into(src, &file)
		};
		#[cfg(not(test))]
		let cloned = imp::clone_into(src, &file);
		if let Err(err) = cloned {
			if let Err(restore) = put_back(&kept, &file) {
				keep = true;
				return Err(io::Error::other(format!(
					"{}; putting the destination's data back failed too ({}), and it is kept in '{}'",
					strerror(&err),
					strerror(&restore),
					kept_path.display()
				)));
			}
			return Err(err);
		}
		Ok(())
	})();
	drop(kept);
	if !keep {
		let _ = fs::remove_file(&kept_path);
	}
	result.map(|()| file)
}

/// `error`'s text without the ` (os error N)` that `io::Error` adds.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn strerror(error: &io::Error) -> String {
	let text = error.to_string();
	match text.find(" (os error ") {
		Some(at) => text[..at].to_owned(),
		None => text,
	}
}

/// Puts the data kept in `kept` back into the emptied `file`: by a clone,
/// else by reading and writing it.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn put_back(kept: &File, file: &File) -> io::Result<()> {
	#[cfg(test)]
	let clone = if FAIL_AFTER_EMPTYING.get() >= 2 {
		Err(io::Error::from_raw_os_error(libc::ENOSPC))
	} else {
		imp::clone_into(kept, file)
	};
	#[cfg(not(test))]
	let clone = imp::clone_into(kept, file);
	if clone.is_ok() {
		return Ok(());
	}
	#[cfg(test)]
	if FAIL_AFTER_EMPTYING.get() >= 3 {
		return Err(io::Error::from_raw_os_error(libc::ENOSPC));
	}
	file.set_len(0)?;
	io::copy(&mut &*kept, &mut &*file).map(drop)
}

/// Gives `clone` the owner and group of the file it replaces, through its
/// descriptor.
#[cfg(unix)]
fn take_owner(clone: &File, metadata: &Metadata) -> io::Result<()> {
	use std::os::unix::fs::{MetadataExt as _, fchown};

	let current = clone.metadata()?;
	if (current.uid(), current.gid()) == (metadata.uid(), metadata.gid()) {
		return Ok(());
	}
	fchown(clone, Some(metadata.uid()), Some(metadata.gid()))
		.map_err(|_| unsupported("clone cannot take the destination's owner"))
}

/// The number of hard links to the file open as `file`.
#[cfg(unix)]
#[expect(clippy::unnecessary_wraps, reason = "the Windows lookup through `file` can fail")]
fn link_count(_file: &File, metadata: &Metadata) -> io::Result<u64> {
	Ok(std::os::unix::fs::MetadataExt::nlink(metadata))
}

#[cfg(windows)]
fn link_count(file: &File, _metadata: &Metadata) -> io::Result<u64> {
	imp::link_count(file)
}

#[cfg(not(any(unix, windows)))]
fn link_count(_file: &File, _metadata: &Metadata) -> io::Result<u64> {
	Err(unsupported("copy-on-write cloning is not implemented on this platform"))
}

/// Creates `dst` as a clone of `src`, and opens it without following a link
/// there: `clonefile` gives no descriptor, so a name swapped for a link after
/// the clone fails the open rather than being followed.
#[cfg(target_os = "macos")]
fn clone_new(src: &Path, dst: &Path) -> io::Result<File> {
	use std::os::unix::fs::OpenOptionsExt as _;

	clonefile(src, dst, 0)?;
	fs::OpenOptions::new()
		.read(true)
		.custom_flags(libc::O_NOFOLLOW)
		.open(dst)
}

/// Creates the missing `dst` as a clone of `src`, removing it again on any
/// failure of the clone.
///
/// On Unix `dst` is created with mode 0600 (`O_CREAT | O_EXCL`): it holds
/// `src`'s data from the clone on, and no other user may open it before its
/// caller gives it its mode, through the descriptor returned. (GNU `cp`
/// clones into the file it opened with the source's permission bits, less
/// those it must not give before the owner is set; 0600 gives no other user
/// any access.)
///
/// Returns `src` and `dst` still open, so the tree-cloning backends, which
/// clone into fresh directories, read the source's metadata and apply it to
/// the clone through the handles rather than by path, and skip
/// [`clone_file`]'s existence probe: a clone across devices fails with an
/// [`is_unsupported`] error anyway.
#[cfg(any(target_os = "linux", target_os = "android", windows))]
pub(crate) fn clone_new(src: &Path, dst: &Path) -> io::Result<(File, File)> {
	let src = File::open(src)?;
	let mut options = fs::OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
	let dst_file = options.open(dst)?;
	if let Err(err) = imp::clone_into(&src, &dst_file) {
		drop(dst_file);
		let _ = fs::remove_file(dst);
		return Err(err);
	}
	Ok((src, dst_file))
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos", windows)))]
fn clone_new(_src: &Path, _dst: &Path) -> io::Result<File> {
	Err(unsupported("copy-on-write cloning is not implemented on this platform"))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod imp {
	use std::{fs::File, io, os::fd::AsRawFd as _};

	// `libc::Ioctl` is `c_int` on musl and `c_ulong` on glibc; the constant
	// fits both.
	const FICLONE: libc::Ioctl = 0x4004_9409;

	/// Clones `src`'s data into the empty `dst`.
	pub fn clone_into(src: &File, dst: &File) -> io::Result<()> {
		// SAFETY: both descriptors are borrowed from live files for the call,
		// and the kernel retains neither.
		(unsafe { libc::ioctl(dst.as_raw_fd(), FICLONE, src.as_raw_fd()) } == 0)
			.ok_or_else(io::Error::last_os_error)
	}

	pub const fn is_unsupported_code(code: i32) -> bool {
		matches!(code, libc::EXDEV | libc::EOPNOTSUPP | libc::ENOTTY | libc::EINVAL | libc::ENOSYS)
	}
}

#[cfg(target_os = "macos")]
mod imp {
	use std::{ffi::CString, io, os::unix::ffi::OsStrExt as _, path::Path};

	/// Clones a symlink itself rather than its target. Darwin's `clonefile.h`
	/// defines it; `libc` does not.
	pub const CLONE_NOFOLLOW: u32 = 0x0001;

	/// `clonefile(src, dst, flags)`; a directory `src` clones its whole tree.
	pub fn clonefile(src: &Path, dst: &Path, flags: u32) -> io::Result<()> {
		let src = CString::new(src.as_os_str().as_bytes())?;
		let dst = CString::new(dst.as_os_str().as_bytes())?;
		// SAFETY: both strings are NUL-terminated and outlive the call, which
		// retains neither pointer.
		(unsafe { libc::clonefile(src.as_ptr(), dst.as_ptr(), flags) } == 0)
			.ok_or_else(io::Error::last_os_error)
	}

	pub const fn is_unsupported_code(code: i32) -> bool {
		matches!(code, libc::ENOTSUP | libc::EOPNOTSUPP | libc::EXDEV)
	}
}

#[cfg(windows)]
mod imp {
	use std::{
		ffi::c_void,
		fs::File,
		io,
		os::windows::{fs::MetadataExt as _, io::AsRawHandle as _},
	};

	use windows_sys::Win32::{
		Foundation::{
			ERROR_ACCESS_DENIED, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER,
			ERROR_NOT_SAME_DEVICE, ERROR_NOT_SUPPORTED,
		},
		Storage::FileSystem::{
			BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_SPARSE_FILE, GetFileInformationByHandle,
		},
		System::{
			IO::DeviceIoControl,
			Ioctl::{
				DUPLICATE_EXTENTS_DATA, FILE_SET_SPARSE_BUFFER, FSCTL_DUPLICATE_EXTENTS_TO_FILE,
				FSCTL_GET_INTEGRITY_INFORMATION, FSCTL_GET_INTEGRITY_INFORMATION_BUFFER,
				FSCTL_SET_INTEGRITY_INFORMATION, FSCTL_SET_INTEGRITY_INFORMATION_BUFFER,
				FSCTL_SET_SPARSE,
			},
		},
	};

	/// Block-clones `src` into the empty `dst`, following the `ReFS` rules
	/// from <https://learn.microsoft.com/windows/win32/fileio/block-cloning>:
	/// each region is cluster-aligned and under 4 GiB, `dst` is extended to
	/// the source length first, and it matches `src`'s integrity-stream and
	/// sparse settings. The last region is rounded up to the whole cluster
	/// holding the end of file, as the `reflink` tools do
	/// (`0xbadfca11/reflink`, `reflink-copy`).
	pub fn clone_into(src: &File, dst: &File) -> io::Result<()> {
		/// The largest cloned region is under 4 GiB.
		const MAX_REGION: u64 = (4 << 30) - 1;

		// Filesystems without block cloning fail here.
		let mut integrity = FSCTL_GET_INTEGRITY_INFORMATION_BUFFER::default();
		fsctl(src, FSCTL_GET_INTEGRITY_INFORMATION, &(), &mut integrity)?;
		let metadata = src.metadata()?;
		let len = metadata.len();
		let cluster = u64::from(integrity.ClusterSizeInBytes).max(1);

		// Best effort: some volumes (reportedly Dev Drive) refuse the change,
		// and a real mismatch then fails the clone itself.
		let _ = fsctl(
			dst,
			FSCTL_SET_INTEGRITY_INFORMATION,
			&FSCTL_SET_INTEGRITY_INFORMATION_BUFFER {
				ChecksumAlgorithm: integrity.ChecksumAlgorithm,
				Reserved:          0,
				Flags:             integrity.Flags,
			},
			&mut (),
		);
		// Sparse while cloning, so extending the end of file allocates no
		// clusters the clone replaces anyway; ReFS also requires it of the
		// destination of a sparse source.
		set_sparse(dst, true)?;
		dst.set_len(len)?;

		let region_limit = MAX_REGION / cluster * cluster;
		let end = len.div_ceil(cluster) * cluster;
		let mut offset = 0;
		while offset < end {
			let count = region_limit.min(end - offset);
			let offset_i64 = i64::try_from(offset).map_err(|_| io::ErrorKind::FileTooLarge)?;
			let data = DUPLICATE_EXTENTS_DATA {
				FileHandle:       src.as_raw_handle() as _,
				SourceFileOffset: offset_i64,
				TargetFileOffset: offset_i64,
				ByteCount:        i64::try_from(count).map_err(|_| io::ErrorKind::FileTooLarge)?,
			};
			fsctl(dst, FSCTL_DUPLICATE_EXTENTS_TO_FILE, &data, &mut ())?;
			offset += count;
		}

		if metadata.file_attributes() & FILE_ATTRIBUTE_SPARSE_FILE == 0 {
			set_sparse(dst, false)?;
		}
		Ok(())
	}

	/// The number of hard links to `file`.
	pub fn link_count(file: &File) -> io::Result<u64> {
		let mut info = BY_HANDLE_FILE_INFORMATION::default();
		// SAFETY: `file` owns a valid handle for the call, and `info` is a live,
		// writable buffer of the expected type.
		if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &raw mut info) } == 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(u64::from(info.nNumberOfLinks))
		}
	}

	pub fn set_sparse(file: &File, sparse: bool) -> io::Result<()> {
		fsctl(file, FSCTL_SET_SPARSE, &FILE_SET_SPARSE_BUFFER { SetSparse: sparse }, &mut ())
	}

	/// Issues the filesystem control `code` on `file` with the plain-data
	/// `input` and `output` buffers; `()` passes no buffer.
	fn fsctl<I, O>(file: &File, code: u32, input: &I, output: &mut O) -> io::Result<()> {
		fn buffer_size<T>() -> u32 {
			u32::try_from(size_of::<T>()).expect("FSCTL buffer fits u32")
		}
		let input_ptr: *const c_void = if size_of::<I>() == 0 {
			std::ptr::null()
		} else {
			std::ptr::from_ref(input).cast()
		};
		let output_ptr: *mut c_void = if size_of::<O>() == 0 {
			std::ptr::null_mut()
		} else {
			std::ptr::from_mut(output).cast()
		};
		let mut returned = 0u32;
		// SAFETY: `file` owns a valid handle for the call, and each buffer
		// pointer is either null with size 0 or points to a live `I`/`O` of the
		// stated size. The call is synchronous, so no pointer outlives it.
		let ok = unsafe {
			DeviceIoControl(
				file.as_raw_handle() as _,
				code,
				input_ptr,
				buffer_size::<I>(),
				output_ptr,
				buffer_size::<O>(),
				&raw mut returned,
				std::ptr::null_mut(),
			)
		};
		(ok != 0).ok_or_else(io::Error::last_os_error)
	}

	pub fn is_unsupported_code(code: i32) -> bool {
		u32::try_from(code).is_ok_and(|code| {
			matches!(
				code,
				ERROR_INVALID_FUNCTION
					| ERROR_NOT_SUPPORTED
					| ERROR_NOT_SAME_DEVICE
					| ERROR_INVALID_PARAMETER
					| ERROR_ACCESS_DENIED
			)
		})
	}
}

#[cfg(all(test, any(target_os = "linux", target_os = "android")))]
mod tests {
	use std::{
		fs::{self, File},
		io,
		os::unix::fs::MetadataExt as _,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::{AFTER_CLONE, FAIL_AFTER_EMPTYING, clone_file, clone_new, imp};

	/// A fresh directory under `parent`, removed with its entries on drop.
	struct Scratch(PathBuf);

	impl Scratch {
		fn under(parent: &Path) -> io::Result<Self> {
			static NEXT: AtomicU64 = AtomicU64::new(0);
			let dir = parent.join(format!(
				".cow-test-{}-{}",
				std::process::id(),
				NEXT.fetch_add(1, Ordering::Relaxed)
			));
			fs::create_dir(&dir)?;
			Ok(Self(dir))
		}
	}

	impl Drop for Scratch {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	/// What `FICLONE` itself answers for `src` into a new file in `dir`:
	/// `None` for a clone, else the error number.
	fn kernel(src: &Path, dir: &Path) -> Option<i32> {
		let probe = dir.join("probe");
		let dst = fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(&probe)
			.unwrap();
		let answer = imp::clone_into(&File::open(src).unwrap(), &dst);
		drop(dst);
		fs::remove_file(&probe).unwrap();
		answer
			.err()
			.map(|error| error.raw_os_error().expect("an OS error"))
	}

	fn names(dir: &Path) -> Vec<String> {
		let mut names: Vec<_> = fs::read_dir(dir)
			.unwrap()
			.map(|entry| entry.unwrap().file_name().into_string().unwrap())
			.collect();
		names.sort();
		names
	}

	/// Clones `src` to a new `b` and over an existing `c` in `dir`, and
	/// returns what differs from `want`, `FICLONE`'s own answer: the same
	/// error number, as GNU `cp --reflink=always` reports it, and after a
	/// failure no `b`, `c` unchanged and no temporary clone left in `dir`.
	fn check(case: &str, src: &Path, dir: &Path, want: Option<i32>) -> Vec<String> {
		let mut failures = Vec::new();
		let before = names(dir);
		let new = dir.join("b");
		let got = clone_file(src, &new)
			.err()
			.map(|error| error.raw_os_error());
		if got != want.map(Some) {
			failures.push(format!("{case}: a new destination: {got:?}, where FICLONE says {want:?}"));
		}
		match want {
			None => assert_eq!(fs::read(&new).unwrap(), b"A", "{case}: the clone"),
			Some(_) if new.exists() => failures.push(format!("{case}: the failed clone left b")),
			Some(_) => {},
		}
		let _ = fs::remove_file(&new);
		let kept = dir.join("c");
		fs::write(&kept, "C").unwrap();
		let got = clone_file(src, &kept)
			.err()
			.map(|error| error.raw_os_error());
		if got != want.map(Some) {
			failures
				.push(format!("{case}: an existing destination: {got:?}, where FICLONE says {want:?}"));
		}
		if want.is_some() && fs::read(&kept).unwrap() != b"C" {
			failures.push(format!("{case}: the failed clone changed c"));
		}
		fs::remove_file(&kept).unwrap();
		if names(dir) != before {
			failures.push(format!("{case}: left {:?} behind, where {before:?} was", names(dir)));
		}
		failures
	}

	/// A clone holds the source's data from the start, so no other user may
	/// open it before its mode is set: a new clone, from [`clone_file`] and
	/// from the tree backends' [`clone_new`], is 0600 when it is handed back,
	/// and the temporary clone that replaces an existing file is 0600 until it
	/// takes that file's mode (read at [`AFTER_CLONE`], between the clone and
	/// the chmod), which it then has. The source is 0644, which a file made
	/// with the umask's mode would get too. Where the filesystem cannot clone
	/// there is no clone to read, and the test says it is skipped.
	#[test]
	fn a_clone_is_private_until_its_mode_is_set() {
		use std::{cell::RefCell, os::unix::fs::PermissionsExt as _, rc::Rc};

		let dir = Scratch::under(&std::env::temp_dir()).unwrap();
		let src = dir.0.join("a");
		fs::write(&src, b"secret").unwrap();
		fs::set_permissions(&src, fs::Permissions::from_mode(0o644)).unwrap();
		if let Some(code) = kernel(&src, &dir.0) {
			eprintln!("skipped: FICLONE says {} here", io::Error::from_raw_os_error(code));
			return;
		}
		let mode = |path: &Path| fs::symlink_metadata(path).unwrap().mode() & 0o7777;
		let mut failures = Vec::new();

		let new = dir.0.join("new");
		let got = clone_file(&src, &new).unwrap().metadata().unwrap().mode() & 0o7777;
		if got != 0o600 {
			failures.push(format!("clone_file made a new clone of mode {got:o}"));
		}
		let tree = dir.0.join("tree");
		let got = clone_new(&src, &tree).unwrap().1.metadata().unwrap().mode() & 0o7777;
		if got != 0o600 {
			failures.push(format!("clone_new made a clone of mode {got:o}"));
		}

		let existing = dir.0.join("existing");
		fs::write(&existing, b"old").unwrap();
		fs::set_permissions(&existing, fs::Permissions::from_mode(0o640)).unwrap();
		let seen = Rc::new(RefCell::new(None));
		{
			let seen = Rc::clone(&seen);
			AFTER_CLONE.set(Some(Box::new(move |temp: &Path| {
				*seen.borrow_mut() = Some(fs::symlink_metadata(temp).unwrap().mode() & 0o7777);
			})));
		}
		let cloned = clone_file(&src, &existing).map(drop);
		AFTER_CLONE.set(None);
		cloned.unwrap();
		match *seen.borrow() {
			Some(0o600) => {},
			Some(got) => failures.push(format!(
				"the temporary clone beside an existing file had mode {got:o} before its chmod"
			)),
			None => failures.push(
				"the seam between the clone and the chmod did not run; the test saw nothing".to_owned(),
			),
		}
		if (mode(&existing), fs::read(&existing).unwrap()) != (0o640, b"secret".to_vec()) {
			failures.push(format!("the existing file after: mode {:o}", mode(&existing)));
		}
		assert!(failures.is_empty(), "{}", failures.join("\n"));
	}

	/// `clone_file` gives the answer `FICLONE` gives for the same two files,
	/// in one directory of whatever filesystem the test runs on (an
	/// overlayfs answers `EOPNOTSUPP` where it cannot clone, though a file
	/// and its directory can show different devices there), on tmpfs, and
	/// from `/dev/shm` into the temporary directory where they are two
	/// filesystems (`EXDEV` on Linux; gVisor answers `EOPNOTSUPP` to every
	/// clone): it decides nothing before the clone, and a failed clone leaves
	/// nothing behind.
	#[test]
	fn clone_file_answers_as_ficlone_does() {
		let temp = Scratch::under(&std::env::temp_dir()).unwrap();
		let shm = Scratch::under(Path::new("/dev/shm")).ok();
		let device = |dir: &Path| fs::metadata(dir).unwrap().dev();
		let mut cases = vec![("one directory", temp.0.clone(), temp.0.clone())];
		match &shm {
			Some(shm) => {
				cases.push(("one directory on /dev/shm", shm.0.clone(), shm.0.clone()));
				if device(&shm.0) == device(&temp.0) {
					eprintln!("skipped: /dev/shm and the temporary directory are one filesystem");
				} else {
					cases.push(("two filesystems", shm.0.clone(), temp.0.clone()));
				}
			},
			None => eprintln!("skipped: no /dev/shm to make a directory in"),
		}
		let mut failures = Vec::new();
		for (case, src_dir, dir) in cases {
			let src = src_dir.join("a");
			if !src.exists() {
				fs::write(&src, "A").unwrap();
			}
			let want = kernel(&src, &dir);
			eprintln!(
				"{case}: FICLONE says {}",
				want.map_or_else(
					|| "yes".to_owned(),
					|code| io::Error::from_raw_os_error(code).to_string()
				)
			);
			failures.extend(check(case, &src, &dir, want));
		}
		assert!(failures.is_empty(), "{}", failures.join("\n"));
	}

	/// A clone refused for its source, here a character device (`EINVAL` on
	/// Linux: not a regular file; gVisor answers `EOPNOTSUPP`), also leaves no
	/// destination behind. Making the device needs root (`CAP_MKNOD`);
	/// elsewhere the test says it skipped.
	#[test]
	fn a_clone_refused_for_a_device_leaves_nothing() {
		let temp = Scratch::under(&std::env::temp_dir()).unwrap();
		let device = temp.0.join("null");
		let path = std::ffi::CString::new(device.as_os_str().as_encoded_bytes()).unwrap();
		// SAFETY: `path` is a NUL-terminated path that outlives the call.
		if unsafe { libc::mknod(path.as_ptr(), libc::S_IFCHR | 0o600, libc::makedev(1, 3)) } != 0 {
			eprintln!("skipped: no character device can be made here: {}", io::Error::last_os_error());
			return;
		}
		let want = kernel(&device, &temp.0);
		eprintln!(
			"a character device: FICLONE says {}",
			want.map_or_else(
				|| "yes".to_owned(),
				|code| io::Error::from_raw_os_error(code).to_string()
			)
		);
		assert!(want.is_some(), "FICLONE from a character device: a clone");
		let failures = check("a character device", &device, &temp.0, want);
		assert!(failures.is_empty(), "{}", failures.join("\n"));
	}

	/// A destination with another hard link is cloned into itself, as GNU
	/// `cp` clones into the file it opened, so both names read the source
	/// afterwards and stay one file: from a source shorter than it, ending
	/// inside a block or at a block's end, and from a longer one. Where the
	/// filesystem cannot clone (tmpfs; gVisor answers `EOPNOTSUPP` to every
	/// clone), the error is `FICLONE`'s and both names keep the old data;
	/// where the clone into the emptied file fails (planted: `ENOSPC`), the
	/// old data is put back, by a clone, or (planted: that clone failing too)
	/// by reading and writing it, and no temporary file is left. Where the
	/// copy fails as well (planted), the error names the file beside the
	/// destination that holds the old data, which is left there, whole, with
	/// mode 0600, and is the only name added. The planted rows need a
	/// filesystem that clones; elsewhere they say they are skipped.
	#[test]
	fn a_destination_with_other_links_is_cloned_into() {
		const BLOCK: usize = 4096;

		let temp = Scratch::under(&std::env::temp_dir()).unwrap();
		let shm = Scratch::under(Path::new("/dev/shm")).ok();
		let mut places = vec![("the temporary directory", temp.0.clone())];
		match &shm {
			Some(shm) => places.push(("/dev/shm", shm.0.clone())),
			None => eprintln!("skipped: no /dev/shm to make a directory in"),
		}
		let mut failures = Vec::new();
		for (place, dir) in places {
			let src = dir.join("a");
			fs::write(&src, "A").unwrap();
			let clones = kernel(&src, &dir);
			eprintln!(
				"{place}: FICLONE says {}",
				clones.map_or_else(
					|| "yes".to_owned(),
					|code| io::Error::from_raw_os_error(code).to_string()
				)
			);
			// (source length, destination length; the shorter ones that end
			// inside a block need the destination emptied first)
			for (src_len, dst_len) in
				[(3, 5), (BLOCK + 5, 2 * BLOCK), (BLOCK, 2 * BLOCK), (2 * BLOCK + 7, 5)]
			{
				let emptied = src_len < dst_len && src_len % BLOCK != 0;
				for planted in [0u8, 1, 2, 3] {
					if planted > 0 && !emptied {
						continue;
					}
					let case = format!("{place}: {src_len} bytes onto {dst_len}{}", match planted {
						0 => "",
						1 => ", the clone into the emptied file failing",
						2 => ", the clone into the emptied file and the clone back failing",
						_ => ", the clone into the emptied file and both ways back failing",
					});
					if planted > 0 && clones.is_some() {
						eprintln!("{case}: skipped, this filesystem does not clone");
						continue;
					}
					let (new, old) = (vec![b'A'; src_len], vec![b'B'; dst_len]);
					fs::write(&src, &new).unwrap();
					let (dst, other) = (dir.join("b"), dir.join("c"));
					fs::write(&dst, &old).unwrap();
					fs::hard_link(&dst, &other).unwrap();
					let before = names(&dir);
					FAIL_AFTER_EMPTYING.set(planted);
					let got = clone_file(&src, &dst).map(drop);
					FAIL_AFTER_EMPTYING.set(0);
					let added: Vec<String> = names(&dir)
						.into_iter()
						.filter(|name| !before.contains(name))
						.collect();
					let data = if planted == 3 {
						// The old data is in the one name added, which the
						// error names; both names of the file are empty.
						match (&got, added.as_slice()) {
							(Err(error), [kept]) => {
								let path = dir.join(kept);
								let message = error.to_string();
								if !kept.starts_with(".cow-clone-")
									|| !message.contains(&path.display().to_string())
								{
									failures.push(format!(
										"{case}: {message:?} does not name the kept file {kept}"
									));
								}
								if !message.starts_with(
									"No space left on device; putting the destination's data back failed \
									 too",
								) {
									failures.push(format!("{case}: {message:?}"));
								}
								if fs::read(&path).unwrap() != old {
									failures.push(format!("{case}: {kept} does not hold the old data"));
								}
								let mode = fs::metadata(&path).unwrap().mode() & 0o7777;
								if mode != 0o600 {
									failures.push(format!("{case}: {kept} has mode {mode:o}, not 600"));
								}
								fs::remove_file(&path).unwrap();
							},
							(got, added) => failures.push(format!(
								"{case}: {got:?} and the names added {added:?}, where an error naming the \
								 one file added is due"
							)),
						}
						Vec::new()
					} else {
						let got = got.map_err(|error| error.raw_os_error());
						let (want, data) = match clones {
							Some(code) => (Err(Some(code)), &old),
							None if planted > 0 => (Err(Some(libc::ENOSPC)), &old),
							None => (Ok(()), &new),
						};
						if got != want {
							failures.push(format!("{case}: {got:?}, where {want:?} is due"));
						}
						if !added.is_empty() {
							failures.push(format!("{case}: left {added:?}"));
						}
						data.clone()
					};
					for name in [&dst, &other] {
						if fs::read(name).unwrap() != data {
							failures.push(format!(
								"{case}: {} holds {} bytes, not the {} due",
								name.display(),
								fs::read(name).unwrap().len(),
								data.len()
							));
						}
					}
					if fs::metadata(&dst).unwrap().ino() != fs::metadata(&other).unwrap().ino() {
						failures.push(format!("{case}: b and c are no longer one file"));
					}
					if names(&dir) != before {
						failures.push(format!("{case}: left {:?}, where {before:?} was", names(&dir)));
					}
					fs::remove_file(&dst).unwrap();
					fs::remove_file(&other).unwrap();
				}
			}
		}
		assert!(failures.is_empty(), "{}", failures.join("\n"));
	}
}
