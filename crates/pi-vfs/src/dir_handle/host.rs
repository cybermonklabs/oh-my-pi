//! A walk's reads by absolute host path, outside any facade.
//!
//! They are what a walker opens before it holds a handle (its root) and
//! outside the tree it walks (ignore files named by path). They know no
//! facade: no creation mask, no cancellation, no descriptor overlay and no
//! provider applies to them or to a handle they open. A caller with a facade
//! opens through it instead ([`crate::Fs::open_dir`], [`crate::Fs::metadata`],
//! ...).

use std::{io, path::Path};

use super::{DirHandle, FileInfo, RegularFile, native, with_scratch};
use crate::{runtime::Scope, types::FileId};

/// Opens the directory at `path` as a host handle outside any facade,
/// following a final symlink only with `follow`.
///
/// Its creations get the mode asked less the process umask, the files it
/// opens observe no cancellation, and it reaches the host entry below a path
/// where a facade has a descriptor overlay. [`crate::Fs::open_dir`] keeps a
/// facade's rules.
///
/// Earlier components are followed. Without `follow`, a symlink that is the
/// last component is refused (`ENOTDIR` on Unix, `ERROR_STOPPED_ON_SYMLINK` on
/// Windows), also on a kernel that follows it despite `O_NOFOLLOW`, as
/// [`DirHandle::open_dir_at`] refuses a listed one.
///
/// # Errors
///
/// The open's errors; `path` not naming a directory.
pub fn open_dir(path: &Path, follow: bool) -> io::Result<DirHandle> {
	DirHandle::open_host(path, follow, &Scope::default())
}

/// Opens the host directory at `path`, following symlinks, only to reach
/// what is below it.
///
/// The handle opens children and identifies the directory. On Linux it is
/// opened `O_PATH`, so it needs only the directory's search permission and
/// cannot be listed; elsewhere it opens as [`open_dir`] does.
///
/// # Errors
///
/// The open's errors; `path` not naming a directory.
pub fn open_dir_to_search(path: &Path) -> io::Result<DirHandle> {
	DirHandle::open_host_to_search(path, &Scope::default())
}

/// Opens the regular file at `path`, following symlinks, and describes it.
///
/// # Errors
///
/// The open's errors; [`super::is_not_regular`] for directories and special
/// files (FIFOs never block the open).
pub fn open_regular(path: &Path) -> io::Result<(RegularFile, FileInfo)> {
	let (handle, info) = with_scratch(|s| native::open_file(s, path))?;
	Ok((RegularFile::Host(super::HostFile(handle)), info))
}

/// Describes the file or directory at `path`, following a final symlink only
/// with `follow`.
///
/// # Errors
///
/// The stat's errors.
pub fn file_info(path: &Path, follow: bool) -> io::Result<FileInfo> {
	with_scratch(|s| native::stat(s, path, follow))
}

/// Identity of the file or directory at `path`, following symlinks.
///
/// # Errors
///
/// The stat's errors (on Windows, the open's: a path stat carries no file
/// index there).
pub fn identify(path: &Path) -> io::Result<FileId> {
	with_scratch(|s| native::identify(s, path))
}
