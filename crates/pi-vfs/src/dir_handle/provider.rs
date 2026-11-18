//! The provider side of [`super::DirHandle`]: a directory is its path on a
//! facade, listings come from `read_dir`, files are facade [`File`]s, and
//! each call joins the entry's name to the directory's path with
//! [`child_path`], which percent-encodes raw names in URLs.
//!
//! A provider resolves each path itself, so opens and writes that do not
//! follow symlinks check the final component with `symlink_metadata` and
//! then open or write by path: two calls, with intermediate directories
//! resolved however the provider resolves them. They refuse a symlink that
//! is there when checked, not one swapped in between the check and the open.
//! Removals remove by path, which removes a final symlink itself.

use std::{
	ffi::OsStr,
	io,
	path::{Component, Path, PathBuf},
	time::UNIX_EPOCH,
};

use super::{
	Detail, FileInfo, FileType, Listing, Stamp, is_rel_separator, not_regular, os_name,
	symlink_refused,
};
use crate::{
	error::{not_a_directory, unsupported},
	file::File,
	fs::Fs,
	metadata::Metadata,
	options::OpenOptions,
	path::child_path,
	types::{self, Permissions},
};

/// Entry type of a facade file type; `None` for special files.
fn type_of(file_type: types::FileType) -> Option<FileType> {
	if file_type.is_symlink() {
		Some(FileType::Symlink)
	} else if file_type.is_dir() {
		Some(FileType::Dir)
	} else if file_type.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

/// Modification time in Unix nanoseconds, when the provider reports one.
fn mtime_of(meta: &Metadata) -> Option<i64> {
	let time = meta.modified().ok()?;
	Some(match time.duration_since(UNIX_EPOCH) {
		Ok(after) => i64::try_from(after.as_nanos()).unwrap_or(i64::MAX),
		Err(before) => i64::try_from(before.duration().as_nanos()).map_or(i64::MIN, |n| -n),
	})
}

pub(super) fn info_of(meta: &Metadata) -> FileInfo {
	let mtime = mtime_of(meta).unwrap_or(0);
	let ctime = meta
		.ctime()
		.zip(meta.ctime_nsec())
		.map_or(mtime, |(sec, nsec)| sec.saturating_mul(1_000_000_000).saturating_add(nsec));
	let id = meta.file_id();
	FileInfo {
		file_type: type_of(meta.file_type()),
		size:      meta.len(),
		stamp:     Stamp {
			dev: id.map_or(0, |id| id.dev()),
			ino: id.map_or(0, |id| id.ino()),
			mtime,
			ctime,
		},
	}
}

/// Entry errors that mean the entry vanished or is unreadable, which
/// listings skip.
fn is_skippable(err: &io::Error) -> bool {
	matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied)
}

/// Names that are empty, contain separators, or parse as roots/prefixes
/// would make walkers address a different path than the listed child.
fn is_invalid_name(name: &OsStr) -> bool {
	name
		.as_encoded_bytes()
		.iter()
		.any(|&b| std::path::is_separator(char::from(b)))
		|| !matches!(
			Path::new(name).components().next(),
			Some(Component::Normal(component)) if component == name
		)
}

/// The entry `name` (raw bytes) of the directory at `dir`.
pub(super) fn child(dir: &Path, name: &[u8]) -> PathBuf {
	child_path(dir, &os_name(name))
}

/// The walk-relative `rel` (raw names, see
/// [`super::DirHandle::open_regular_beneath_async`]) below `root`.
pub(super) fn beneath(root: &Path, rel: &[u8]) -> PathBuf {
	let mut path = root.to_path_buf();
	for segment in rel.split(|&b| is_rel_separator(b)) {
		path = child(&path, segment);
	}
	path
}

/// The description of a regular file from metadata read without following a
/// final symlink: a symlink there is refused ([`symlink_refused`]), and
/// anything else that is not a regular file fails as [`not_regular`].
fn unlinked_file_info(meta: &Metadata) -> io::Result<FileInfo> {
	let info = info_of(meta);
	match info.file_type {
		Some(FileType::File) => Ok(info),
		Some(FileType::Symlink) => Err(symlink_refused()),
		_ => Err(not_regular()),
	}
}

/// Checks that `path` is a directory, following a final symlink only with
/// `follow`.
pub(super) async fn open_dir(fs: &Fs, path: &Path, follow: bool) -> io::Result<()> {
	let meta = if follow {
		fs.metadata(path).await?
	} else {
		fs.symlink_metadata(path).await?
	};
	if !meta.is_dir() {
		return Err(not_a_directory());
	}
	Ok(())
}

pub(super) async fn list(fs: &Fs, dir: &Path, detail: Detail, out: &mut Listing) -> io::Result<()> {
	for entry in fs.read_dir(dir).await? {
		let entry = entry?;
		let name = entry.file_name();
		if matches!(name.as_encoded_bytes(), b"." | b"..") {
			continue;
		}
		if is_invalid_name(&name) {
			return Err(io::Error::new(
				io::ErrorKind::InvalidData,
				format!("filesystem returned invalid directory entry name {}", name.display()),
			));
		}
		let file_type = match entry.file_type_async().await {
			Ok(file_type) => file_type,
			Err(err) if is_skippable(&err) => continue,
			Err(err) => return Err(err),
		};
		let Some(file_type) = type_of(file_type) else {
			continue;
		};
		let (size, mtime) = match detail {
			Detail::Minimal => (None, None),
			Detail::Full => match entry.metadata_async().await {
				Ok(meta) => ((file_type == FileType::File).then(|| meta.len()), mtime_of(&meta)),
				Err(err) if is_skippable(&err) => continue,
				Err(err) => return Err(err),
			},
		};
		out.push(name.as_encoded_bytes(), file_type, size, mtime, 0);
	}
	Ok(())
}

/// Opens the regular file at `path`, following symlinks. The type is checked
/// before opening so directories and special files are never opened.
pub(super) async fn open_file(fs: &Fs, path: &Path) -> io::Result<(File, FileInfo)> {
	let info = info_of(&fs.metadata(path).await?);
	if info.file_type != Some(FileType::File) {
		return Err(not_regular());
	}
	Ok((fs.open(path).await?, info))
}

/// Opens the regular file at `path`, refusing a final symlink: the type is
/// checked without following it before the open.
pub(super) async fn open_file_unlinked(fs: &Fs, path: &Path) -> io::Result<(File, FileInfo)> {
	let info = unlinked_file_info(&fs.symlink_metadata(path).await?)?;
	Ok((fs.open(path).await?, info))
}

/// Replaces the contents of the regular file at `path`, creating it when
/// missing, refusing a final symlink or special file: the type is checked
/// without following it before the write.
pub(super) async fn write_file_unlinked(fs: &Fs, path: &Path, contents: &[u8]) -> io::Result<()> {
	match fs.symlink_metadata(path).await {
		Ok(meta) => {
			unlinked_file_info(&meta)?;
		},
		Err(err) if err.kind() == io::ErrorKind::NotFound => {},
		Err(err) => return Err(err),
	}
	fs.write(path, contents).await
}

/// Removes the entry at `path` (an empty directory when `dir`).
pub(super) async fn remove(fs: &Fs, path: &Path, dir: bool) -> io::Result<()> {
	if dir {
		fs.remove_dir(path).await
	} else {
		fs.remove_file(path).await
	}
}

pub(super) async fn stat(fs: &Fs, path: &Path, follow: bool) -> io::Result<FileInfo> {
	let meta = if follow {
		fs.metadata(path).await?
	} else {
		fs.symlink_metadata(path).await?
	};
	Ok(info_of(&meta))
}

/// Whether the entry at `path` is a symlink; a missing entry is not.
async fn is_link(fs: &Fs, path: &Path) -> io::Result<bool> {
	match fs.symlink_metadata(path).await {
		Ok(meta) => Ok(meta.is_symlink()),
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
		Err(err) => Err(err),
	}
}

/// Opens `path` as `options` say, refusing a symlink there
/// ([`symlink_refused`]): the check and the open are two calls.
pub(super) async fn open_at(fs: &Fs, path: &Path, options: &OpenOptions) -> io::Result<File> {
	if is_link(fs, path).await? {
		return Err(symlink_refused());
	}
	fs.open_with(path, options).await
}

/// Sets the permissions of `path`; without `follow` a symlink there is
/// refused ([`unsupported`]), as Linux refuses to change a symlink's mode,
/// since a provider's change follows one.
pub(super) async fn set_permissions(
	fs: &Fs,
	path: &Path,
	permissions: Permissions,
	follow: bool,
) -> io::Result<()> {
	if !follow && is_link(fs, path).await? {
		return Err(unsupported("changing the mode of a symbolic link"));
	}
	fs.set_permissions(path, permissions).await
}
