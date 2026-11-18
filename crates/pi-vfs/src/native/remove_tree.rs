//! Removing a directory tree with a bounded number of descriptors.
//!
//! `std::fs::remove_dir_all` keeps every directory between the top and the one
//! it empties open, one descriptor per level, so it fails with `EMFILE` on a
//! tree deeper than the open-file limit (`ulimit -n`, often 1024): `mv` of a
//! deep directory across file systems copied it and then could not remove the
//! source. GNU `rm` and `mv` remove through fts, which bounds its descriptors.
//! Here at most three are open at once whatever the depth: the top's parent,
//! the directory being emptied, and one more while a child is entered, the
//! parent is re-entered or a directory is listed.
//!
//! No symbolic link is followed, as with `std::fs::remove_dir_all`: a
//! directory is entered through its parent's descriptor with `O_NOFOLLOW`,
//! and kept only if the entry, read without following, is a directory with
//! the device and inode of what was opened (gVisor does not honour
//! `O_NOFOLLOW` with `O_DIRECTORY`); anything else is removed as an entry. A
//! directory is left through its `..`, which must be the directory it was
//! entered from; if it was moved meanwhile, the removal stops with an error
//! rather than remove anything outside the tree.

use std::{
	ffi::{CStr, CString},
	io,
	os::{
		fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd},
		unix::ffi::OsStrExt,
	},
	path::Path,
};

use crate::error::nul_in_path;

const DIR_FLAGS: libc::c_int =
	libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

/// A file's device and inode.
type Identity = (libc::dev_t, libc::ino_t);

/// Removes the directory `path` and everything below it, as
/// `std::fs::remove_dir_all` does; a symbolic link `path` is removed itself.
pub(crate) fn remove_dir_all(path: &Path) -> io::Result<()> {
	let (Some(name), parent) = (path.file_name(), path.parent()) else {
		// `/`, `..` or an empty path: no name in a parent stands for it.
		return std::fs::remove_dir_all(path);
	};
	let parent = match parent {
		Some(parent) if !parent.as_os_str().is_empty() => parent,
		_ => Path::new("."),
	};
	let name = CString::new(name.as_bytes()).map_err(|_| nul_in_path())?;
	let parent = CString::new(parent.as_os_str().as_bytes()).map_err(|_| nul_in_path())?;
	// SAFETY: `parent` is NUL-terminated; the result is checked.
	let parent = owned(unsafe { libc::open(parent.as_ptr(), DIR_FLAGS & !libc::O_NOFOLLOW) })?;
	let Some(top) = enter(&parent, &name)? else {
		// A symbolic link is removed itself; anything else is no directory.
		let mode = stat_at(&parent, &name)?.0;
		if mode & libc::S_IFMT != libc::S_IFLNK {
			return Err(io::Error::from_raw_os_error(libc::ENOTDIR));
		}
		return unlinkat(&parent, &name, 0);
	};
	empty(top)?;
	unlinkat(&parent, &name, libc::AT_REMOVEDIR)
}

/// What runs before a listed subdirectory is entered, with its name.
#[cfg(test)]
type EnterHook = Box<dyn FnMut(&CStr)>;

#[cfg(test)]
thread_local! {
	/// Runs before a listed subdirectory is entered: a test changes the entry
	/// here, as another process could.
	static BEFORE_ENTER: std::cell::RefCell<Option<EnterHook>> = const { std::cell::RefCell::new(None) };
}

/// A directory entered while its parent was being emptied.
struct Level {
	/// Its name in the parent.
	name:           CString,
	/// The parent's identity, which `..` must have on the way up.
	parent:         Identity,
	/// The parent's subdirectories still to remove.
	parent_pending: Vec<CString>,
}

/// Empties the directory `top`, closing it.
fn empty(top: OwnedFd) -> io::Result<()> {
	let mut current = top;
	let mut pending = list_and_unlink_files(&current)?;
	let mut levels: Vec<Level> = Vec::new();
	loop {
		if let Some(child) = pending.pop() {
			#[cfg(test)]
			BEFORE_ENTER.with_borrow_mut(|hook| {
				if let Some(hook) = hook {
					hook(&child);
				}
			});
			match enter(&current, &child) {
				Ok(Some(entered)) => {
					let parent = identity(&current)?;
					levels.push(Level {
						name: child,
						parent,
						parent_pending: std::mem::take(&mut pending),
					});
					current = entered;
					pending = list_and_unlink_files(&current)?;
				},
				// Replaced by a symbolic link or a file since it was listed.
				Ok(None) => unlink_entry(&current, &child)?,
				Err(err) if err.raw_os_error() == Some(libc::ENOENT) => {},
				Err(err) => return Err(err),
			}
			continue;
		}
		let Some(level) = levels.pop() else {
			return Ok(());
		};
		// SAFETY: `current` is open and the name is NUL-terminated.
		let up = owned(unsafe { libc::openat(current.as_raw_fd(), c"..".as_ptr(), DIR_FLAGS) })?;
		if identity(&up)? != level.parent {
			return Err(io::Error::other(
				"a directory was moved out of the tree while it was being removed",
			));
		}
		drop(current);
		unlinkat(&up, &level.name, libc::AT_REMOVEDIR)?;
		current = up;
		pending = level.parent_pending;
	}
}

/// The directory `name` in `dir`, opened without following a symbolic link;
/// `None` when the entry is no directory (a symbolic link among them).
fn enter(dir: &OwnedFd, name: &CStr) -> io::Result<Option<OwnedFd>> {
	// SAFETY: `dir` is open and `name` NUL-terminated; the result is checked.
	let entered = match owned(unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), DIR_FLAGS) }) {
		Ok(entered) => entered,
		Err(err) if matches!(err.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)) => {
			return Ok(None);
		},
		Err(err) => return Err(err),
	};
	let (mode, entry) = stat_at(dir, name)?;
	Ok((mode & libc::S_IFMT == libc::S_IFDIR && entry == identity(&entered)?).then_some(entered))
}

/// Removes the entry `name` of `dir`, which is no directory; one already gone
/// is removed.
fn unlink_entry(dir: &OwnedFd, name: &CStr) -> io::Result<()> {
	match unlinkat(dir, name, 0) {
		Err(err) if err.raw_os_error() != Some(libc::ENOENT) => Err(err),
		_ => Ok(()),
	}
}

/// Lists `dir`, removes every entry that is no directory, and returns the
/// names of its subdirectories. The listing holds one more descriptor (a
/// duplicate of `dir`'s) until it is read.
fn list_and_unlink_files(dir: &OwnedFd) -> io::Result<Vec<CString>> {
	let listing = dir.try_clone()?.into_raw_fd();
	// SAFETY: on success the stream owns `listing`; on failure it does not.
	let stream = unsafe { libc::fdopendir(listing) };
	if stream.is_null() {
		let err = io::Error::last_os_error();
		// SAFETY: `listing` is still this function's.
		drop(unsafe { OwnedFd::from_raw_fd(listing) });
		return Err(err);
	}
	let mut entries = Vec::new();
	let read = read_all(stream, &mut entries);
	// SAFETY: `stream` came from `fdopendir` and is closed once, with `listing`.
	unsafe { libc::closedir(stream) };
	read?;
	let mut subdirs = Vec::new();
	for (name, d_type) in entries {
		let is_dir = match d_type {
			libc::DT_DIR => true,
			libc::DT_UNKNOWN => match stat_at(dir, &name) {
				Ok((mode, _)) => mode & libc::S_IFMT == libc::S_IFDIR,
				Err(err) if err.raw_os_error() == Some(libc::ENOENT) => continue,
				Err(err) => return Err(err),
			},
			_ => false,
		};
		if is_dir {
			subdirs.push(name);
		} else {
			unlink_entry(dir, &name)?;
		}
	}
	Ok(subdirs)
}

/// Every entry of `stream` but `.` and `..`, with its `d_type`.
fn read_all(stream: *mut libc::DIR, entries: &mut Vec<(CString, u8)>) -> io::Result<()> {
	loop {
		// SAFETY: errno is cleared so that a NULL return can be told apart.
		unsafe { *errno() = 0 };
		// SAFETY: `stream` is an open directory stream.
		let entry = unsafe { libc::readdir(stream) };
		if entry.is_null() {
			// SAFETY: reads this thread's errno.
			let code = unsafe { *errno() };
			return if code == 0 {
				Ok(())
			} else {
				Err(io::Error::from_raw_os_error(code))
			};
		}
		// SAFETY: `readdir` returned a valid entry whose name is NUL-terminated.
		let (name, d_type) = unsafe { (CStr::from_ptr((*entry).d_name.as_ptr()), (*entry).d_type) };
		if name.to_bytes() != b"." && name.to_bytes() != b".." {
			entries.push((name.to_owned(), d_type));
		}
	}
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn errno() -> *mut libc::c_int {
	// SAFETY: returns this thread's errno location.
	unsafe { libc::__errno_location() }
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn errno() -> *mut libc::c_int {
	// SAFETY: returns this thread's errno location.
	unsafe { libc::__error() }
}

fn unlinkat(dir: &OwnedFd, name: &CStr, flags: libc::c_int) -> io::Result<()> {
	// SAFETY: `dir` is open and `name` NUL-terminated.
	if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), flags) } == -1 {
		return Err(io::Error::last_os_error());
	}
	Ok(())
}

/// The mode and identity of the entry `name` of `dir`, not following a link.
fn stat_at(dir: &OwnedFd, name: &CStr) -> io::Result<(libc::mode_t, Identity)> {
	// SAFETY: an all-zero `stat` is valid, and `fstatat` fills it.
	let mut st: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: `dir` is open, `name` NUL-terminated, `st` writable.
	if unsafe {
		libc::fstatat(dir.as_raw_fd(), name.as_ptr(), &raw mut st, libc::AT_SYMLINK_NOFOLLOW)
	} == -1
	{
		return Err(io::Error::last_os_error());
	}
	Ok((st.st_mode, (st.st_dev, st.st_ino)))
}

fn identity(dir: &OwnedFd) -> io::Result<Identity> {
	// SAFETY: an all-zero `stat` is valid, and `fstat` fills it.
	let mut st: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: `dir` is open and `st` writable.
	if unsafe { libc::fstat(dir.as_raw_fd(), &raw mut st) } == -1 {
		return Err(io::Error::last_os_error());
	}
	Ok((st.st_dev, st.st_ino))
}

fn owned(fd: RawFd) -> io::Result<OwnedFd> {
	if fd == -1 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `fd` was just opened and nobody else owns it.
	Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		os::{
			fd::{AsRawFd, FromRawFd},
			unix::fs::symlink,
		},
		path::PathBuf,
	};

	use super::{BEFORE_ENTER, remove_dir_all};

	/// A fresh directory of this test's own under the system temp dir.
	fn scratch(tag: &str) -> PathBuf {
		let dir =
			std::env::temp_dir().join(format!("pi-vfs-remove-tree-{tag}-{}", std::process::id()));
		let _ = remove_dir_all(&dir);
		fs::create_dir(&dir).unwrap();
		dir
	}

	/// Files, subdirectories at several levels with siblings, and symbolic
	/// links go; what a link points at, outside the tree, stays.
	#[test]
	fn removes_the_tree_and_follows_no_link() {
		let base = scratch("links");
		let outside = base.join("outside");
		fs::create_dir(&outside).unwrap();
		fs::write(outside.join("kept"), b"k").unwrap();
		let top = base.join("top");
		for dir in ["a/b/c", "a/b/c2", "a/x", "y/z"] {
			fs::create_dir_all(top.join(dir)).unwrap();
		}
		fs::write(top.join("a/f"), b"1").unwrap();
		fs::write(top.join("a/b/c/g"), b"2").unwrap();
		fs::write(top.join("y/z/h"), b"3").unwrap();
		symlink(&outside, top.join("a/to-outside")).unwrap();
		symlink("missing", top.join("dangling")).unwrap();
		remove_dir_all(&top).unwrap();
		assert!(!top.exists());
		assert_eq!(fs::read(outside.join("kept")).unwrap(), b"k");
		remove_dir_all(&base).unwrap();
		assert!(!base.exists());
	}

	/// A symbolic link named as the top is removed itself, as std does; a
	/// file is no directory, and a missing path is not found.
	#[test]
	fn a_link_top_is_removed_and_a_file_top_refused() {
		let base = scratch("top");
		fs::create_dir(base.join("target")).unwrap();
		fs::write(base.join("target/kept"), b"k").unwrap();
		symlink(base.join("target"), base.join("link")).unwrap();
		remove_dir_all(&base.join("link")).unwrap();
		assert!(fs::symlink_metadata(base.join("link")).is_err());
		assert!(base.join("target/kept").exists());
		fs::write(base.join("file"), b"f").unwrap();
		let refused = remove_dir_all(&base.join("file")).unwrap_err();
		assert_eq!(refused.raw_os_error(), Some(libc::ENOTDIR));
		let missing = remove_dir_all(&base.join("missing")).unwrap_err();
		assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);
		remove_dir_all(&base).unwrap();
	}

	/// A directory replaced by a symbolic link between its listing and its
	/// removal is removed as the link: neither what the link points at nor
	/// the directory moved away is touched. On Linux `O_NOFOLLOW` refuses the
	/// link; where it is not honoured with `O_DIRECTORY` (gVisor), the entry's
	/// own identity refuses it.
	#[test]
	fn a_directory_swapped_for_a_link_while_listed_is_removed_as_the_link() {
		let base = scratch("swap");
		let outside = base.join("outside");
		fs::create_dir(&outside).unwrap();
		fs::write(outside.join("kept"), b"k").unwrap();
		let top = base.join("top");
		fs::create_dir_all(top.join("victim/inner")).unwrap();
		fs::write(top.join("victim/inner/f"), b"f").unwrap();
		let (victim, moved, target) = (top.join("victim"), base.join("moved"), outside.clone());
		BEFORE_ENTER.set(Some(Box::new(move |name| {
			if name.to_bytes() == b"victim" {
				fs::rename(&victim, &moved).unwrap();
				symlink(&target, &victim).unwrap();
			}
		})));
		let removed = remove_dir_all(&top);
		BEFORE_ENTER.set(None);
		removed.unwrap();
		assert!(!top.exists());
		assert_eq!(fs::read(outside.join("kept")).unwrap(), b"k");
		assert_eq!(fs::read(base.join("moved/inner/f")).unwrap(), b"f");
		remove_dir_all(&base).unwrap();
	}

	/// A chain whose paths pass `PATH_MAX`: every directory is reached through
	/// its parent's descriptor, never by path.
	#[test]
	fn removes_a_chain_whose_paths_pass_path_max() {
		let base = scratch("chain");
		let top = base.join("deep");
		fs::create_dir(&top).unwrap();
		let name = c"level";
		let levels = usize::try_from(libc::PATH_MAX).unwrap() / (name.count_bytes() + 1) + 100;
		let mut dir = fs::File::open(&top).unwrap();
		for _ in 0..levels {
			// SAFETY: `dir` is open and `name` NUL-terminated.
			assert_eq!(unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o755) }, 0);
			// SAFETY: as above; the result is checked before use.
			let next = unsafe {
				libc::openat(
					dir.as_raw_fd(),
					name.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
				)
			};
			assert!(next >= 0, "{}", std::io::Error::last_os_error());
			// SAFETY: `next` was just opened and is owned here.
			dir = unsafe { fs::File::from_raw_fd(next) };
		}
		drop(dir);
		remove_dir_all(&top).unwrap();
		assert!(!top.exists());
		remove_dir_all(&base).unwrap();
	}
}
