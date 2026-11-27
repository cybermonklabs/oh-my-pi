//! `rm` builtin: remove files and directory trees.
//!
//! Ported from uutils coreutils 0.8.0.

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::{
	ffi::{OsStr, OsString},
	fmt,
	io::{self, Read, Write},
	ops::BitOr,
	path::{Component, MAIN_SEPARATOR, Path, PathBuf, Prefix},
};

use clap::{
	Arg, ArgAction, ArgMatches, Command,
	builder::{PossibleValue, ValueParser},
	parser::ValueSource,
};
use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle, TermLike};
use parking_lot::Mutex;
use crate::openfile::OpenFile;
use pi_vfs::{Metadata, child_path, is_virtual_path, normalize_lexically, parent_path};
use thiserror::Error;
use uucore::{display::Quotable, parser::shortcut_value_parser::ShortcutValueParser};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, strip_errno};

macro_rules! show_error {
	($host:expr, $($args:tt)+) => {{
		$host.error(format_args!($($args)+), 1);
	}};
}

macro_rules! prompt_yes {
	($host:expr, $($args:tt)+) => {{
		use std::io::Write as _;
		let _ = write!($host.stderr, "rm: ");
		let _ = write!($host.stderr, $($args)+);
		let _ = write!($host.stderr, " ");
		let _ = $host.stderr.flush();
		$crate::rm::read_yes($host)
	}};
}

fn read_yes(host: &mut Host) -> bool {
	let mut byte = [0u8; 1];
	let mut first = None;
	loop {
		match host.stdin.read(&mut byte) {
			Ok(0) => break,
			Err(_) => return false,
			Ok(_) if byte[0] == b'\n' => break,
			Ok(_) => first.get_or_insert(byte[0]),
		};
	}
	matches!(first, Some(b'y' | b'Y'))
}

#[cfg(unix)]
mod platform {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// Unix-specific implementations for the rm utility
//
// Descriptor-relative traversal (`openat`/`unlinkat`) only applies to paths
// the injected filesystem confirms are native host paths; every other path
// goes through the provider operations in the parent module.


use std::{
	collections::HashSet,
	ffi::{OsStr, OsString},
	os::unix::ffi::OsStrExt,
	path::{Path, PathBuf},
};

use indicatif::ProgressBar;
use uucore::{display::Quotable, safe_traversal::{DirFd, SymlinkBehavior}};

use super::{
	Host,
	InteractiveMode, Options, is_dir_empty, is_missing_under_force, prompt_descend,
	remove_dir_with_special_cases, remove_file, remove_unreadable_dir, report_unless_missing,
	show_removal_error, verbose_removed_directory, verbose_removed_file,
};

#[inline]
fn mode_readable(mode: libc::mode_t) -> bool {
	(mode & libc::S_IRUSR) != 0
}

#[inline]
fn mode_writable(mode: libc::mode_t) -> bool {
	(mode & libc::S_IWUSR) != 0
}

/// File prompt that reuses existing stat data to avoid extra statx calls
fn prompt_file_with_stat(host: &mut Host, path: &Path, stat: &libc::stat, options: &Options) -> bool {
	if options.interactive == InteractiveMode::Never {
		return true;
	}

	let is_symlink = ((stat.st_mode as libc::mode_t) & libc::S_IFMT) == libc::S_IFLNK;
	let writable = mode_writable(stat.st_mode as libc::mode_t);
	let len = stat.st_size as u64;
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);

	// Match original behaviour:
	// - Interactive::Always: always prompt; use non-protected wording when
	//   writable, otherwise fall through to protected wording.
	if options.interactive == InteractiveMode::Always {
		if is_symlink {
			return prompt_yes!(host, "remove symbolic link {}?", path.quote());
		}
		if writable {
			return if len == 0 {
				prompt_yes!(host, "remove regular empty file {}?", path.quote())
			} else {
				prompt_yes!(host, "remove file {}?", path.quote())
			};
		}
		// Not writable: use protected wording below
	}

	// Interactive::Once or ::PromptProtected (and non-writable Always) paths
	match (stdin_ok, writable, len == 0) {
		(false, ..) if options.interactive == InteractiveMode::PromptProtected => true,
		(_, true, _) => true,
		(_, false, true) => {
			prompt_yes!(host, "remove write-protected regular empty file {}?", path.quote())
		},
		_ => prompt_yes!(host, "remove write-protected regular file {}?", path.quote()),
	}
}

/// Directory prompt that reuses existing stat data to avoid extra statx calls
fn prompt_dir_with_mode(host: &mut Host, path: &Path, mode: libc::mode_t, options: &Options) -> bool {
	if options.interactive == InteractiveMode::Never {
		return true;
	}

	let readable = mode_readable(mode as libc::mode_t);
	let writable = mode_writable(mode as libc::mode_t);
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);

	match (stdin_ok, readable, writable, options.interactive) {
		(false, _, _, InteractiveMode::PromptProtected) => true,
		(false, false, false, InteractiveMode::Never) => true,
		(_, false, false, _) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, false, true, InteractiveMode::Always) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, true, false, _) => prompt_yes!(host, "remove write-protected directory {}?", path.quote()),
		(_, _, _, InteractiveMode::Always) => prompt_yes!(host, "remove directory {}?", path.quote()),
		(..) => true,
	}
}

/// The host directory containing `path` and the entry name within it, when the
/// injected filesystem confirms the resolved operand is a native host path.
///
/// The operand itself is checked, never a lexical parent: a URL such as
/// `mem://victim` has the std parent `mem:`, which would name the unrelated
/// host directory `<cwd>/mem:`.
fn native_entry(host: &Host, path: &Path) -> Option<(PathBuf, OsString)> {
	let resolved = host.resolve(path);
	if !host.fs().is_native_local(&resolved) {
		return None;
	}
	let parent = resolved.parent()?.to_path_buf();
	let name = resolved.file_name()?.to_os_string();
	Some((parent, name))
}

/// Remove a single file using safe traversal.
///
/// Returns `None` when `path` is not a native host path, so the caller
/// removes the file through the injected filesystem instead.
pub fn safe_remove_file(host: &mut Host, 
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> Option<bool> {
	let (parent, file_name) = native_entry(host, path)?;
	let dir_fd = DirFd::open(&parent, SymlinkBehavior::Follow).ok()?;

	match dir_fd.unlink_at(&file_name, false) {
		Ok(_) => {
			// Update progress bar for file removal
			if let Some(pb) = progress_bar {
				pb.inc(1);
			}
			verbose_removed_file(host, path, options);
			Some(false)
		},
		Err(e) if is_missing_under_force(&e, options) => Some(false),
		Err(e) => Some(show_removal_error(host, e, path)),
	}
}

/// Remove an empty directory using safe traversal.
///
/// Returns `None` when `path` is not a native host path, so the caller
/// removes the directory through the injected filesystem instead.
pub fn safe_remove_empty_dir(host: &mut Host, 
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> Option<bool> {
	let (parent, dir_name) = native_entry(host, path)?;
	let dir_fd = DirFd::open(&parent, SymlinkBehavior::Follow).ok()?;

	match dir_fd.unlink_at(&dir_name, true) {
		Ok(_) => {
			// Update progress bar for directory removal
			if let Some(pb) = progress_bar {
				pb.inc(1);
			}
			verbose_removed_directory(host, path, options);
			Some(false)
		},
		Err(e) if is_missing_under_force(&e, options) => Some(false),
		Err(e) => Some(show_removal_error(host, e, path)),
	}
}

/// Helper to handle unlink operation with error reporting
fn handle_unlink(host: &mut Host,
	dir_fd: &DirFd,
	entry_name: &OsStr,
	entry_path: &Path,
	is_dir: bool,
	options: &Options,
) -> bool {
	if let Err(e) = dir_fd.unlink_at(entry_name, is_dir) {
		return report_unless_missing(host, e, entry_path, options);
	}
	if is_dir {
		verbose_removed_directory(host, entry_path, options);
	} else {
		verbose_removed_file(host, entry_path, options);
	}
	false
}

/// Removes a native host directory tree with descriptor-relative traversal.
///
/// Callers MUST have confirmed that `path` resolves to a native host path.
pub fn safe_remove_dir_recursive(host: &mut Host, 
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	if host.is_cancelled() {
		return true;
	}

	let path_fs = host.resolve(path);
	// Base case 1: this is a file or a symbolic link.
	// Use lstat to avoid race condition between check and use
	let (initial_mode, initial_id) = match host.fs().symlink_metadata(&path_fs) {
		Ok(metadata) if !metadata.is_dir() => {
			return remove_file(host, path, options, progress_bar);
		},
		Ok(metadata) => (metadata.permissions().mode(), metadata.dev().zip(metadata.ino())),
		Err(e) if is_missing_under_force(&e, options) => return false,
		Err(e) => {
			return show_removal_error(host, e, path);
		},
	};

	// Open the operand as the directory the lstat found, not following a
	// symlink there: anything swapped in since the lstat, a symlink or another
	// directory, is refused (`ENOTDIR`) and kept, an empty directory too. One
	// that cannot be opened or listed is removed if it is empty, as GNU rm
	// does.
	#[cfg(test)]
	crate::host::run_hook(path);
	let dir_fd = match open_stat_dir(&path_fs, initial_id) {
		Ok(fd) => fd,
		Err(e) if is_missing_under_force(&e, options) => return false,
		// Not the directory the lstat found: nothing at this name is rm's to
		// remove.
		Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => return show_removal_error(host, e, path),
		Err(e) => {
			let removal = host.fs().remove_dir(&path_fs);
			return remove_unreadable_dir(host, path, options, e, removal);
		},
	};
	let entries = match dir_fd.read_dir() {
		Ok(entries) => entries,
		Err(e) if is_missing_under_force(&e, options) => return false,
		Err(e) => {
			drop(dir_fd);
			let removal = host.fs().remove_dir(&path_fs);
			return remove_unreadable_dir(host, path, options, e, removal);
		},
	};

	let error = safe_remove_dir_recursive_impl(host, path, dir_fd, entries, options);

	// After processing all children, remove the directory itself
	if error {
		error
	} else {
		// Ask user permission if needed
		if options.interactive == InteractiveMode::Always
			&& !prompt_dir_with_mode(host, path, initial_mode as libc::mode_t, options)
		{
			return false;
		}

		// Before trying to remove the directory, check if it's actually empty
		// This handles the case where some children weren't removed due to user "no"
		// responses
		if !is_dir_empty(host, path) {
			// Directory is not empty, so we can't/shouldn't remove it
			// In interactive mode, this might be expected if user said "no" to some
			// children In non-interactive mode, this indicates an error (some children
			// couldn't be removed)
			if options.interactive == InteractiveMode::Always {
				return false;
			}
			// Try to remove the directory anyway and let the system tell us why it failed
			// Use false for error_occurred since this is the main error we want to report
			return remove_dir_with_special_cases(host, path, options, false);
		}

		// Directory is empty and user approved removal
		if let Some(result) = safe_remove_empty_dir(host, path, options, progress_bar) {
			result
		} else {
			remove_dir_with_special_cases(host, path, options, error)
		}
	}
}

/// A directory suspended while one of its entries is being emptied. Together
/// with the directory being walked, only the deepest [`OPEN_DIR_FDS`] keep
/// their descriptor; the others get it back through ".." on the way up, so
/// depth costs memory, not file descriptors.
#[cfg(not(target_os = "redox"))]
struct Frame {
	dir_fd:     Option<DirFd>,
	dev:        u64,
	ino:        u64,
	entries:    std::vec::IntoIter<OsString>,
	error:      bool,
	/// The entry being emptied, removed once that is done.
	entry_name: OsString,
	entry_mode: libc::mode_t,
	/// Length of this directory's own path, to cut the entry back off with.
	path_len:   usize,
}

#[cfg(not(target_os = "redox"))]
const OPEN_DIR_FDS: usize = 16;

/// The path of the directory being walked, kept as raw bytes so that stepping
/// into an entry and back out again is a truncation rather than a fresh
/// allocation.
#[cfg(not(target_os = "redox"))]
fn path_of(buf: &[u8]) -> &Path {
	Path::new(OsStr::from_bytes(buf))
}

#[cfg(not(target_os = "redox"))]
fn path_push(buf: &mut Vec<u8>, name: &OsStr) {
	if !buf.is_empty() && buf.last() != Some(&b'/') {
		buf.push(b'/');
	}
	buf.extend_from_slice(name.as_bytes());
}

/// Whether `name` is an empty directory in `dir_fd`, asked through the
/// descriptor rather than the path: past `PATH_MAX` a path-based check fails,
/// and a failure counts as non-empty. An unreadable directory still counts as
/// non-empty, and so does one that is not the directory `id` (see
/// [`open_stat_subdir`]).
#[cfg(not(target_os = "redox"))]
fn is_subdir_empty(dir_fd: &DirFd, name: &OsStr, id: (u64, u64)) -> bool {
	open_stat_subdir(dir_fd, name, id)
		.and_then(|fd| fd.read_dir())
		.is_ok_and(|entries| entries.is_empty())
}

/// Opens the operand `path` without following a symlink that is its final
/// component, kept only as the directory `id` (device, inode) that `lstat`
/// found: anything else there is `ENOTDIR`. The identity is compared as well
/// because gVisor before release-20261109.0 follows a final symlink to a
/// directory despite `O_NOFOLLOW` when `O_DIRECTORY` is set (see
/// [`open_stat_subdir`]). `id` is `None` when the `lstat` gave no identity,
/// and then nothing is kept.
fn open_stat_dir(path: &Path, id: Option<(u64, u64)>) -> std::io::Result<DirFd> {
	let fd = DirFd::open(path, SymlinkBehavior::NoFollow)?;
	let info = fd.metadata()?.file_info();
	if Some((info.device(), info.inode())) == id {
		Ok(fd)
	} else {
		Err(std::io::Error::from_raw_os_error(libc::ENOTDIR))
	}
}

/// Opens the subdirectory `name` of `dir_fd`, without following a symlink
/// there, as the directory `id` (device, inode) that `stat_at` found at the
/// name: anything else there is `ENOTDIR`, Linux's refusal of a symlink at a
/// directory open. `open_subdir` opens with `O_DIRECTORY | O_NOFOLLOW`, and
/// gVisor before release-20261109.0 (GKE Sandbox's among them) follows a
/// final symlink to a directory despite `O_NOFOLLOW` when `O_DIRECTORY` is
/// set (google/gvisor#14786), so a directory swapped for a symlink since the
/// stat would take the walk off the tree. gnulib's fts makes this comparison
/// only for `..` and for walks that follow links (`fts_safe_changedir`); GNU
/// rm's physical walk relies on `O_NOFOLLOW` instead, which those gVisor
/// releases do not honour here.
#[cfg(not(target_os = "redox"))]
fn open_stat_subdir(dir_fd: &DirFd, name: &OsStr, id: (u64, u64)) -> std::io::Result<DirFd> {
	let fd = dir_fd.open_subdir(name, SymlinkBehavior::NoFollow)?;
	let info = fd.metadata()?.file_info();
	if (info.device(), info.inode()) == id {
		Ok(fd)
	} else {
		Err(std::io::Error::from_raw_os_error(libc::ENOTDIR))
	}
}

/// GNU's warning for a directory that is its own ancestor.
#[cfg(not(target_os = "redox"))]
fn show_cycle_error(host: &mut Host, path: &Path) {
	show_error!(
		host,
		"WARNING: Circular directory structure.\nThis almost certainly means that you have a \
		 corrupted file system.\nNOTIFY YOUR SYSTEM MANAGER.\nThe following directory is part of \
		 the cycle:\n  {}\n",
		path.maybe_quote()
	);
}

/// Reopen the parent of `child_fd` through "..", checking it is still the
/// directory we descended from and not one swapped in mid-walk.
#[cfg(not(target_os = "redox"))]
fn reopen_parent(child_fd: &DirFd, dev: u64, ino: u64) -> std::io::Result<DirFd> {
	let parent_fd = child_fd.open_subdir(OsStr::new(".."), SymlinkBehavior::NoFollow)?;
	let info = parent_fd.metadata()?.file_info();
	if info.device() == dev && info.inode() == ino {
		Ok(parent_fd)
	} else {
		Err(std::io::Error::from(std::io::ErrorKind::NotFound))
	}
}

/// Empties the directory open as `cur_fd`, whose path is `path` and whose
/// listing is `entries`, leaving the directory itself for the caller. Returns
/// whether any error occurred.
///
/// Walks with an explicit stack: recursing once per level overflows the
/// thread's stack on a tree tens of thousands of levels deep, and that kills
/// the whole process rather than failing the command.
#[cfg(not(target_os = "redox"))]
pub fn safe_remove_dir_recursive_impl(
	host: &mut Host,
	path: &Path,
	mut cur_fd: DirFd,
	entries: Vec<OsString>,
	options: &Options,
) -> bool {
	let (mut dev, mut ino) = match cur_fd.metadata() {
		Ok(metadata) => {
			let info = metadata.file_info();
			(info.device(), info.inode())
		},
		Err(e) => return show_removal_error(host, e, path),
	};
	let mut entries = entries.into_iter();

	let mut error = false;
	let mut path_buf = path.as_os_str().as_bytes().to_vec();
	let mut stack: Vec<Frame> = Vec::new();
	// Identities of the directories on the walk's path: a directory that is
	// its own ancestor (a bind mount inside itself) would otherwise be walked
	// until memory runs out, since descriptors let the walk pass PATH_MAX.
	let mut ancestors = HashSet::from([(dev, ino)]);

	loop {
		if host.is_cancelled() {
			return true;
		}

		let Some(entry_name) = entries.next() else {
			// This directory is done: resume its parent, which removes it.
			let Some(parent) = stack.pop() else {
				return error;
			};
			cur_fd = if let Some(fd) = parent.dir_fd {
				fd
			} else {
				match reopen_parent(&cur_fd, parent.dev, parent.ino) {
					Ok(fd) => fd,
					Err(e) => {
						// Name the parent, not the entry we came up from.
						path_buf.truncate(parent.path_len);
						return show_removal_error(host, e, path_of(&path_buf));
					},
				}
			};
			let child_error = error;
			ancestors.remove(&(dev, ino));
			(dev, ino, entries) = (parent.dev, parent.ino, parent.entries);
			error = parent.error | child_error;

			// Ask user permission if needed for this subdirectory, then remove
			// the now-empty subdirectory using safe unlinkat.
			if !child_error
				&& (options.interactive != InteractiveMode::Always
					|| prompt_dir_with_mode(host, path_of(&path_buf), parent.entry_mode, options))
			{
				error |= handle_unlink(host, &cur_fd, &parent.entry_name, path_of(&path_buf), true, options);
			}
			path_buf.truncate(parent.path_len);
			continue;
		};

		let parent_len = path_buf.len();
		path_push(&mut path_buf, &entry_name);
		let descended = 'entry: {
			// Get metadata for the entry using fstatat
			let entry_stat = match cur_fd.stat_at(&entry_name, SymlinkBehavior::NoFollow) {
				Ok(stat) => stat,
				Err(e) => {
					error |= report_unless_missing(host, e, path_of(&path_buf), options);
					break 'entry false;
				},
			};

			let is_dir = ((entry_stat.st_mode as libc::mode_t) & libc::S_IFMT) == libc::S_IFDIR;
			if !is_dir {
				// Remove file - check if user wants to remove it first
				if prompt_file_with_stat(host, path_of(&path_buf), &entry_stat, options) {
					error |= handle_unlink(host, &cur_fd, &entry_name, path_of(&path_buf), false, options);
				}
				break 'entry false;
			}

			// st_dev's type varies by platform (i32 on macOS, u64 on Linux).
			#[allow(clippy::unnecessary_cast)]
			let entry_id = (entry_stat.st_dev as u64, entry_stat.st_ino as u64);
			if ancestors.contains(&entry_id) {
				show_cycle_error(host, path_of(&path_buf));
				error = true;
				break 'entry false;
			}

			// Ask user if they want to descend into this directory
			if options.interactive == InteractiveMode::Always
				&& !is_subdir_empty(&cur_fd, &entry_name, entry_id)
				&& !prompt_descend(host, path_of(&path_buf))
			{
				break 'entry false;
			}

			// Open the just-stat'd subdirectory as that directory, not
			// following a symlink: anything swapped in since the stat, a
			// symlink or another directory, makes the open fail (`ENOTDIR`)
			// instead of taking the walk off the tree, and is kept, an empty
			// directory too. One that cannot be opened or listed is removed if
			// it is empty, as GNU rm does.
			#[cfg(test)]
			crate::host::run_hook(path_of(&path_buf));
			let child_fd = match open_stat_subdir(&cur_fd, &entry_name, entry_id) {
				Ok(fd) => fd,
				Err(e) if is_missing_under_force(&e, options) => break 'entry false,
				// Not the directory the stat found: nothing at this name is
				// rm's to remove.
				Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => {
					error |= show_removal_error(host, e, path_of(&path_buf));
					break 'entry false;
				},
				Err(e) => {
					let removal = cur_fd.unlink_at(&entry_name, true);
					error |= remove_unreadable_dir(host, path_of(&path_buf), options, e, removal);
					break 'entry false;
				},
			};

			let child_entries = match child_fd.read_dir() {
				Ok(child_entries) => child_entries.into_iter(),
				Err(e) if is_missing_under_force(&e, options) => break 'entry false,
				Err(e) => {
					drop(child_fd);
					let removal = cur_fd.unlink_at(&entry_name, true);
					error |= remove_unreadable_dir(host, path_of(&path_buf), options, e, removal);
					break 'entry false;
				},
			};

			// Suspend this directory and empty the subdirectory first.
			stack.push(Frame {
				dir_fd: Some(std::mem::replace(&mut cur_fd, child_fd)),
				dev,
				ino,
				entries: std::mem::replace(&mut entries, child_entries),
				error: std::mem::replace(&mut error, false),
				entry_name,
				entry_mode: entry_stat.st_mode as libc::mode_t,
				path_len: parent_len,
			});
			if let Some(closable) = stack.len().checked_sub(OPEN_DIR_FDS) {
				stack[closable].dir_fd = None;
			}
			ancestors.insert(entry_id);
			(dev, ino) = entry_id;
			true
		};
		if !descended {
			path_buf.truncate(parent_len);
		}
	}
}

#[cfg(target_os = "redox")]
pub fn safe_remove_dir_recursive_impl(
	host: &mut Host,
	_path: &Path,
	_dir_fd: DirFd,
	_entries: Vec<OsString>,
	_options: &Options,
) -> bool {
	// safe_traversal stat_at is not supported on Redox
	// This shouldn't be called on Redox, but provide a stub for compilation
	true // Return error
}

/// The device-and-inode checks on their own, on any kernel: a real directory
/// at the name that is not the one `stat_at` or `lstat` found is refused, for
/// the descent, for `-i`'s emptiness listing, and for the operand.
#[cfg(all(test, not(target_os = "redox")))]
mod stat_subdir_tests {
	use std::{ffi::OsStr, os::unix::fs::MetadataExt};

	use uucore::safe_traversal::{DirFd, SymlinkBehavior};

	use super::{is_subdir_empty, open_stat_dir, open_stat_subdir};

	#[test]
	fn a_subdirectory_that_is_not_the_one_stat_at_found_is_refused() {
		let tmp = tempfile::tempdir().unwrap();
		std::fs::create_dir(tmp.path().join("sub")).unwrap();
		std::fs::create_dir(tmp.path().join("other")).unwrap();
		let id = |name: &str| {
			let meta = std::fs::symlink_metadata(tmp.path().join(name)).unwrap();
			(meta.dev(), meta.ino())
		};
		let dir = DirFd::open(tmp.path(), SymlinkBehavior::NoFollow).unwrap();
		let sub = OsStr::new("sub");
		assert!(open_stat_subdir(&dir, sub, id("sub")).is_ok(), "the directory stat_at found");
		let err = open_stat_subdir(&dir, sub, id("other")).err().expect("another directory's id was accepted");
		assert_eq!(err.raw_os_error(), Some(libc::ENOTDIR));
		assert!(is_subdir_empty(&dir, sub, id("sub")), "the empty directory stat_at found");
		assert!(!is_subdir_empty(&dir, sub, id("other")), "-i listed a directory stat_at did not find");
	}

	#[test]
	fn an_operand_that_is_not_the_directory_lstat_found_is_refused() {
		let tmp = tempfile::tempdir().unwrap();
		std::fs::create_dir(tmp.path().join("sub")).unwrap();
		std::fs::create_dir(tmp.path().join("other")).unwrap();
		let id = |name: &str| {
			let meta = std::fs::symlink_metadata(tmp.path().join(name)).unwrap();
			Some((meta.dev(), meta.ino()))
		};
		let sub = tmp.path().join("sub");
		assert!(open_stat_dir(&sub, id("sub")).is_ok(), "the directory lstat found");
		let err = open_stat_dir(&sub, id("other")).err().expect("another directory's id was accepted");
		assert_eq!(err.raw_os_error(), Some(libc::ENOTDIR));
		let err = open_stat_dir(&sub, None).err().expect("an operand with no identity was accepted");
		assert_eq!(err.raw_os_error(), Some(libc::ENOTDIR));
	}
}

}
#[cfg(all(unix, not(target_os = "redox")))]
use platform::{safe_remove_dir_recursive, safe_remove_empty_dir, safe_remove_file};

#[derive(Debug, Error)]
enum RmError {
	#[error("missing operand\nTry 'rm --help' for more information.")]
	MissingOperand,
	#[error("cannot remove {}: No such file or directory", _0.quote())]
	CannotRemoveNoSuchFile(OsString),
	#[error("cannot remove {}: Permission denied", _0.quote())]
	CannotRemovePermissionDenied(OsString),
	#[error("cannot remove {}: Is a directory", _0.quote())]
	CannotRemoveIsDirectory(OsString),
	#[error("it is dangerous to operate recursively on '/'")]
	DangerousRecursiveOperation,
	#[error("use --no-preserve-root to override this failsafe")]
	UseNoPreserveRoot,
	#[error("refusing to remove '.' or '..' directory: skipping {}", _0.quote())]
	RefusingToRemoveDirectory(OsString),
	#[error("you may not abbreviate the --no-preserve-root option")]
	MayNotAbbreviateNoPreserveRoot,
}

/// Lexically normalized operand for verbose output; URL operands keep their
/// `scheme://` root.
fn display_path(path: &Path) -> PathBuf {
	if is_virtual_path(path) {
		normalize_lexically(path)
	} else {
		uucore::fs::normalize_path(path)
	}
}

/// Helper function to print verbose message for removed file
fn verbose_removed_file(host: &mut Host, path: &Path, options: &Options) {
	if options.verbose {
		let _ = writeln!(host.stdout, "removed {}", display_path(path).quote());
	}
}

/// Helper function to print verbose message for removed directory
fn verbose_removed_directory(host: &mut Host, path: &Path, options: &Options) {
	if options.verbose {
		let _ = writeln!(host.stdout, "removed directory {}", display_path(path).quote());
	}
}

/// Reports that `path` could not be removed, with GNU's `strerror` text for
/// `error`; a filesystem's permission refusal that carries no OS error reads
/// as EACCES does. Returns the error status, `true`.
fn show_removal_error(host: &mut Host, error: io::Error, path: &Path) -> bool {
	let reason = if error.kind() == io::ErrorKind::PermissionDenied && error.raw_os_error().is_none() {
		"Permission denied".to_owned()
	} else {
		strip_errno(&error)
	};
	show_error!(host, "cannot remove {}: {reason}", path.quote());
	true
}

/// Helper function for permission denied errors
fn show_permission_denied_error(host: &mut Host, path: &Path) -> bool {
	show_error!(host, "cannot remove {}: Permission denied", path.quote());
	true
}

/// Whether `e` says the name names no file, which `-f` ignores as GNU rm does
/// (`remove.c`, `nonexistent_file_errno`): the entry is already gone (another
/// process may remove part of the tree while it is walked), a component of
/// its path is not a directory, or the filesystem rejects the name (EINVAL,
/// EILSEQ). Nothing else is ignored, under `-f` or not.
///
/// As in GNU rm, a later `-i`, `-I` or `--interactive=always|once` cancels
/// that; the parser then leaves an interactive mode other than `Never`.
fn is_missing_under_force(e: &io::Error, options: &Options) -> bool {
	options.force
		&& !matches!(options.interactive, InteractiveMode::Always | InteractiveMode::Once)
		&& (matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) || names_no_file(e))
}

/// GNU's `nonexistent_file_errno` (remove.c) also counts EINVAL and EILSEQ: a
/// name the filesystem rejects (smbfs gives EINVAL, POSIX asks for EILSEQ)
/// names no file there.
#[cfg(unix)]
fn names_no_file(e: &io::Error) -> bool {
	matches!(e.raw_os_error(), Some(libc::EINVAL | libc::EILSEQ))
}

#[cfg(not(unix))]
fn names_no_file(_: &io::Error) -> bool {
	false
}

/// Reports `e` for `path` unless `-f` ignores it ([`is_missing_under_force`]).
/// Returns whether it was reported, which is the error status.
fn report_unless_missing(host: &mut Host, e: io::Error, path: &Path, options: &Options) -> bool {
	!is_missing_under_force(&e, options) && show_removal_error(host, e, path)
}

/// GNU rm's answer for the directory `path` it could not open or list
/// (`read`): it tries to remove it all the same, as it may be empty, and
/// `removal` is that attempt. A removal that succeeds, or that `-f` ignores,
/// is no error. One refused because the directory is not empty says less than
/// why it could not be read, so that reason is reported; any other refusal is
/// reported as itself. Returns the error status.
#[cfg(unix)]
fn remove_unreadable_dir(
	host: &mut Host,
	path: &Path,
	options: &Options,
	read: io::Error,
	removal: io::Result<()>,
) -> bool {
	match removal {
		Ok(()) => {
			verbose_removed_directory(host, path, options);
			false
		},
		Err(e) if is_missing_under_force(&e, options) => false,
		Err(e)
			if matches!(
				e.kind(),
				io::ErrorKind::DirectoryNotEmpty
					| io::ErrorKind::IsADirectory
					| io::ErrorKind::NotADirectory
					| io::ErrorKind::AlreadyExists
			) =>
		{
			show_removal_error(host, read, path)
		},
		Err(e) => show_removal_error(host, e, path),
	}
}

/// Removes the empty directory `fs_path`.
///
/// On Windows a directory carrying the read-only attribute refuses removal,
/// although on Unix only the parent's permissions decide; the attribute is
/// cleared for one more attempt and put back if that fails too.
fn remove_empty_dir(host: &mut Host, fs_path: &Path) -> io::Result<()> {
	let result = host.fs().remove_dir(fs_path);
	#[cfg(windows)]
	if result
		.as_ref()
		.is_err_and(|e| e.kind() == io::ErrorKind::PermissionDenied)
	{
		// A step that finds the directory gone reports that, which `-f`
		// ignores, rather than the stale `PermissionDenied`.
		let gone = |e: io::Error| (e.kind() == io::ErrorKind::NotFound).then_some(e);
		let metadata = match host.fs().symlink_metadata(fs_path) {
			Ok(metadata) => metadata,
			Err(e) => return Err(gone(e).unwrap_or_else(|| result.unwrap_err())),
		};
		// Not a symlink or junction: set_permissions would follow it.
		if metadata.is_dir() && metadata.permissions().readonly() {
			let mut writable = metadata.permissions();
			writable.set_readonly(false);
			if let Err(e) = host.fs().set_permissions(fs_path, writable) {
				return Err(gone(e).unwrap_or_else(|| result.unwrap_err()));
			}
			let retry = host.fs().remove_dir(fs_path);
			if retry.is_err() {
				// Best effort: the retry's error is the one to report.
				let _ = host.fs().set_permissions(fs_path, metadata.permissions());
			}
			return retry;
		}
	}
	result
}

/// Helper function to remove directory handling special cases
fn remove_dir_with_special_cases(host: &mut Host, path: &Path, options: &Options, error_occurred: bool) -> bool {
	let path_fs = host.resolve(path);
	match remove_empty_dir(host, &path_fs) {
		Err(e) if is_missing_under_force(&e, options) => false,
		Err(_) if !error_occurred && !is_readable(host, path) => {
			// For compatibility with GNU test case
			// `tests/rm/unread2.sh`, show "Permission denied" in this
			// case instead of "Directory not empty".
			show_permission_denied_error(host, path);
			true
		},
		Err(_) if !error_occurred && host.fs().read_dir(&path_fs).is_err() => {
			// For compatibility with GNU test case on Linux
			// Check if directory is readable by attempting to read it
			show_permission_denied_error(host, path);
			true
		},
		Err(e) if !error_occurred => show_removal_error(host, e, path),
		Err(_) => {
			// If we already had errors while
			// trying to remove the children, then there is no need to
			// show another error message as we return from each level
			// of the recursion.
			error_occurred
		},
		Ok(()) => {
			verbose_removed_directory(host, path, options);
			false
		},
	}
}

/// Helper function to remove a directory and handle results
fn remove_dir_with_feedback(host: &mut Host, path: &Path, options: &Options) -> bool {
	let path_fs = host.resolve(path);
	match remove_empty_dir(host, &path_fs) {
		Ok(_) => {
			verbose_removed_directory(host, path, options);
			false
		},
		Err(e) if is_missing_under_force(&e, options) => false,
		Err(e) => show_removal_error(host, e, path),
	}
}

#[derive(Eq, PartialEq, Clone, Copy)]
/// Enum, determining when the `rm` will prompt the user about the file deletion
pub enum InteractiveMode {
	/// Never prompt
	Never,
	/// Prompt once before removing more than three files, or when removing
	/// recursively.
	Once,
	/// Prompt before every removal
	Always,
	/// Prompt only on write-protected files
	PromptProtected,
}

// We implement `From` instead of `TryFrom` because clap guarantees that we only
// receive valid values.
//
// The `PromptProtected` variant is not supposed to be created from a string.
impl From<&str> for InteractiveMode {
	fn from(s: &str) -> Self {
		match s {
			"never" => Self::Never,
			"once" => Self::Once,
			"always" => Self::Always,
			_ => unreachable!("should be prevented by clap"),
		}
	}
}

/// Options for the `rm` command
///
/// All options are public so that the options can be programmatically
/// constructed by other crates, such as Nushell. That means that this struct
/// is part of our public API. It should therefore not be changed without good
/// reason.
///
/// The fields are documented with the arguments that determine their value.
pub struct Options {
	/// `-f`, `--force`
	pub force:               bool,
	/// Iterative mode, determines when the command will prompt.
	///
	/// Set by the following arguments:
	/// - `-i`: [`InteractiveMode::Always`]
	/// - `-I`: [`InteractiveMode::Once`]
	/// - `--interactive`: sets one of the above or [`InteractiveMode::Never`]
	/// - `-f`: implicitly sets [`InteractiveMode::Never`]
	///
	/// If no other option sets this mode, [`InteractiveMode::PromptProtected`]
	/// is used
	pub interactive:         InteractiveMode,
	#[allow(dead_code, reason = "--one-file-system is parsed but intentionally unimplemented upstream")]
	/// `--one-file-system`
	pub one_fs:              bool,
	/// `--preserve-root`/`--no-preserve-root`
	pub preserve_root:       bool,
	/// `-r`, `--recursive`
	pub recursive:           bool,
	/// `-d`, `--dir`
	pub dir:                 bool,
	/// `-v`, `--verbose`
	pub verbose:             bool,
	/// `-g`, `--progress`
	pub progress:            bool,
	#[doc(hidden)]
	/// `---presume-input-tty`
	/// Always use `None`; GNU flag for testing use only
	pub __presume_input_tty: Option<bool>,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			force:               false,
			interactive:         InteractiveMode::PromptProtected,
			one_fs:              false,
			preserve_root:       true,
			recursive:           false,
			dir:                 false,
			verbose:             false,
			progress:            false,
			__presume_input_tty: None,
		}
	}
}

static OPT_DIR: &str = "dir";
static OPT_INTERACTIVE: &str = "interactive";
static OPT_FORCE: &str = "force";
static OPT_NO_PRESERVE_ROOT: &str = "no-preserve-root";
static OPT_ONE_FILE_SYSTEM: &str = "one-file-system";
static OPT_PRESERVE_ROOT: &str = "preserve-root";
static OPT_PROMPT_ALWAYS: &str = "prompt-always";
static OPT_PROMPT_ONCE: &str = "prompt-once";
static OPT_RECURSIVE: &str = "recursive";
static OPT_VERBOSE: &str = "verbose";
static OPT_PROGRESS: &str = "progress";
static PRESUME_INPUT_TTY: &str = "-presume-input-tty";

static ARG_FILES: &str = "files";

/// Parsed `rm` invocation.
pub(crate) struct Rm {
	matches: ArgMatches,
}

matches_parser!(Rm, uu_app);

impl Utility for Rm {
	const NAME: &'static str = "rm";
	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		const FULL: &str = "--no-preserve-root";
		for arg in argv.iter().skip(1) {
			let Some(arg) = arg.to_str() else {
				continue;
			};
			if arg == "--" {
				break;
			}
			if arg.starts_with("--") && arg.len() < FULL.len() && FULL.starts_with(arg) {
				return Err(RmError::MayNotAbbreviateNoPreserveRoot.to_string());
			}
		}
		Ok(argv)
	}


	fn run(self, host: &mut Host) -> i32 {
		run_matches(host, &self.matches)
	}
}

fn run_matches(host: &mut Host, matches: &ArgMatches) -> i32 {
	let files: Vec<_> = matches
		.get_many::<OsString>(ARG_FILES)
		.map_or_default(|v| v.map(OsString::as_os_str).collect());

	let force_flag = matches.get_flag(OPT_FORCE);
	if files.is_empty() && !force_flag {
		host.error(RmError::MissingOperand, 1);
		return 1;
	}

	// If -f(--force) is before any -i (or variants) we want prompts else no prompts.
	let force_prompt_never = force_flag && {
		let force_index = matches.index_of(OPT_FORCE).unwrap_or(0);
		![OPT_PROMPT_ALWAYS, OPT_PROMPT_ONCE, OPT_INTERACTIVE]
			.iter()
			.any(|flag| {
				matches.value_source(flag) == Some(ValueSource::CommandLine)
					&& matches.index_of(flag).unwrap_or(0) > force_index
			})
	};


	let options = Options {
		force: force_flag,
		interactive: {
			if force_prompt_never {
				InteractiveMode::Never
			} else if matches.get_flag(OPT_PROMPT_ALWAYS) {
				InteractiveMode::Always
			} else if matches.get_flag(OPT_PROMPT_ONCE) {
				InteractiveMode::Once
			} else if matches.contains_id(OPT_INTERACTIVE) {
				InteractiveMode::from(matches.get_one::<String>(OPT_INTERACTIVE).unwrap().as_str())
			} else {
				InteractiveMode::PromptProtected
			}
		},
		one_fs: matches.get_flag(OPT_ONE_FILE_SYSTEM),
		preserve_root: !matches.get_flag(OPT_NO_PRESERVE_ROOT),
		recursive: matches.get_flag(OPT_RECURSIVE),
		dir: matches.get_flag(OPT_DIR),
		verbose: matches.get_flag(OPT_VERBOSE),
		progress: matches.get_flag(OPT_PROGRESS),
		__presume_input_tty: Some(
			matches.get_flag(PRESUME_INPUT_TTY) || host.stdin.file().is_terminal(),
		),
	};

	if options.interactive == InteractiveMode::Once && (options.recursive || files.len() > 3) {
		let msg = format!(
			"remove {} {}{}",
			files.len(),
			if files.len() > 1 { "arguments" } else { "argument" },
			if options.recursive { " recursively?" } else { "?" }
		);
		if !prompt_yes!(host, "{msg}") {
			return 0;
		}
	}

	if remove(host, &files, &options) {
		host.fail(1);
	}
	host.exit_code()
}

pub fn uu_app() -> Command {
	Command::new("rm")
		.version("0.8.0")
		.about("Remove (unlink) the FILE(s)")
		.override_usage(format_usage("rm [OPTION]... FILE..."))
		.after_help(
			"By default, rm does not remove directories. Use the --recursive (-r or -R)\noption to \
			 remove each listed directory, too, along with all of its contents\n\nTo remove a file \
			 whose name starts with a '-', for example '-foo',\nuse one of these commands:\nrm -- \
			 -foo\n\nrm ./-foo\n\nNote that if you use rm to remove a file, it might be possible to \
			 recover\nsome of its contents, given sufficient expertise and/or time. For \
			 greater\nassurance that the contents are truly unrecoverable, consider using shred.",
		)
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(OPT_FORCE)
				.short('f')
				.long(OPT_FORCE)
				.help("ignore nonexistent files and arguments, never prompt")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROMPT_ALWAYS)
				.short('i')
				.help("prompt before every removal")
				.overrides_with_all([OPT_PROMPT_ONCE, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROMPT_ONCE)
				.short('I')
				.help(
					"prompt once before removing more than three files, or when removing \
					 recursively.\nLess intrusive than -i, while still giving some protection against \
					 most mistakes",
				)
				.overrides_with_all([OPT_PROMPT_ALWAYS, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INTERACTIVE)
				.long(OPT_INTERACTIVE)
				.help(
					"prompt according to WHEN: never, once (-I), or always (-i). Without \
					 WHEN,\nprompts always",
				)
				.value_name("WHEN")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("always").alias("yes"),
					PossibleValue::new("once"),
					PossibleValue::new("never").alias("no").alias("none"),
				]))
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value("always")
				.overrides_with_all([OPT_PROMPT_ALWAYS, OPT_PROMPT_ONCE]),
		)
		.arg(
			Arg::new(OPT_ONE_FILE_SYSTEM)
				.long(OPT_ONE_FILE_SYSTEM)
				.help(
					"when removing a hierarchy recursively, skip any directory that is on a \
					 file\nsystem different from that of the corresponding command line argument \
					 (NOT\nIMPLEMENTED)",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_PRESERVE_ROOT)
				.long(OPT_NO_PRESERVE_ROOT)
				.help("do not treat '/' specially")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PRESERVE_ROOT)
				.long(OPT_PRESERVE_ROOT)
				.help("do not remove '/' (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RECURSIVE)
				.short('r')
				.visible_short_alias('R')
				.long(OPT_RECURSIVE)
				.help("remove directories and their contents recursively")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_DIR)
				.short('d')
				.long(OPT_DIR)
				.help("remove empty directories")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_VERBOSE)
				.short('v')
				.long(OPT_VERBOSE)
				.help("explain what is being done")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROGRESS)
				.short('g')
				.long(OPT_PROGRESS)
				.help("display a progress bar. Note: this feature is not supported by GNU coreutils.")
				.action(ArgAction::SetTrue),
		)
		// From the GNU source code:
		// This is solely for testing.
		// Do not document.
		// It is relatively difficult to ensure that there is a tty on stdin.
		// Since rm acts differently depending on that, without this option,
		// it'd be harder to test the parts of rm that depend on that setting.
		// In contrast with Arg::long, Arg::alias does not strip leading
		// hyphens. Therefore it supports 3 leading hyphens.
		.arg(
			Arg::new(PRESUME_INPUT_TTY)
				.long("presume-input-tty")
				.alias(PRESUME_INPUT_TTY)
				.hide(true)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.num_args(1..)
				.value_hint(clap::ValueHint::AnyPath),
		)
}

/// Terminal adapter that directs progress rendering to the builtin's stderr.
struct HostTerm(Mutex<OpenFile>);

impl fmt::Debug for HostTerm {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("HostTerm")
	}
}

impl TermLike for HostTerm {
	fn width(&self) -> u16 {
		80
	}

	fn move_cursor_up(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}A")
	}

	fn move_cursor_down(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}B")
	}

	fn move_cursor_right(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}C")
	}

	fn move_cursor_left(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}D")
	}

	fn write_line(&self, s: &str) -> io::Result<()> {
		writeln!(self.0.lock(), "{s}")
	}

	fn write_str(&self, s: &str) -> io::Result<()> {
		write!(self.0.lock(), "{s}")
	}

	fn clear_line(&self) -> io::Result<()> {
		write!(self.0.lock(), "\r\x1b[2K")
	}

	fn flush(&self) -> io::Result<()> {
		self.0.lock().flush()
	}
}

/// Returns Some(ProgressBar) if `total_files` > 0, None otherwise.
fn create_progress_bar(host: &mut Host, files: &[&OsStr], recursive: bool) -> Option<ProgressBar> {
	if !host.stderr.is_terminal() {
		return None;
	}
	let total_files = count_files(host, files, recursive);
	if total_files == 0 {
		return None;
	}

	let progress = ProgressBar::with_draw_target(
		Some(total_files),
		ProgressDrawTarget::term_like(Box::new(HostTerm(Mutex::new(host.stderr_clone())))),
	)
	.with_style(
		ProgressStyle::with_template(
			"{msg}: [{elapsed_precise}] {wide_bar} {pos:>7}/{len:7} files",
		)
		.unwrap(),
	)
	.with_message("Removing");
	Some(progress)
}

/// Count the total number of files and directories to be deleted.
/// This function recursively counts all files and directories that will be
/// processed. Files are not deduplicated when appearing in multiple sources. If
/// `recursive` is set to `false`, the directories in `paths` will be ignored.
fn count_files(host: &mut Host, paths: &[&OsStr], recursive: bool) -> u64 {
	let mut total = 0;
	for p in paths {
		if host.is_cancelled() {
			break;
		}

		// Empty operands are rejected by `remove(host, )` before deletion; skip them
		// here too so the progress pre-count doesn't resolve "" to the cwd and
		// walk the entire working directory into the total.
		if p.is_empty() {
			continue;
		}
		let path = Path::new(p);
		if let Ok(md) = host.fs().symlink_metadata(&host.resolve(path)) {
			if md.is_dir() && !is_symlink_dir(&md) {
				if recursive {
					total += count_files_in_directory(host, path);
				}
			} else {
				total += 1;
			}
		}
		// If we can't access the file, skip it for counting
		// This matches the behavior where -f suppresses errors for missing files
	}
	total
}

/// A helper for `count_files` specialized for directories.
fn count_files_in_directory(host: &mut Host, p: &Path) -> u64 {
	if host.is_cancelled() {
		return 0;
	}
	let mut entries_count = 0;
	let Ok(entries) = host.fs().read_dir(&host.resolve(p)) else {
		return 1;
	};
	for entry in entries.flatten() {
		if host.is_cancelled() {
			break;
		}
		entries_count += match entry.file_type() {
			Ok(ft) if ft.is_dir() => count_files_in_directory(host, &entry.path()),
			Ok(_) => 1,
			Err(_) => 0,
		};
	}
	1 + entries_count
}


// TODO: implement one-file-system (this may get partially implemented in
// walkdir)
/// Remove (or unlink) the given files
///
/// Returns true if it has encountered an error.
///
/// Behavior is determined by the `options` parameter, see [`Options`] for
/// details.
pub fn remove(host: &mut Host, files: &[&OsStr], options: &Options) -> bool {
	let mut had_err = false;

	// Check if any files actually exist before creating progress bar
	let mut progress_bar: Option<ProgressBar> = None;
	let mut any_files_processed = false;

	for filename in files {
		if host.is_cancelled() {
			break;
		}

		let file = Path::new(filename);

		// An empty operand can never name a real file. Guard it before
		// `Host::resolve`, which joins "" onto the shell's working
		// directory — without this, `rm -rf ""` resolves to the cwd and
		// recursively deletes it. GNU rm reports ENOENT for an empty operand
		// (and `rm -f` stays silent), so mirror that here.
		if filename.is_empty() {
			if !options.force {
				show_error!(host, "{}", RmError::CannotRemoveNoSuchFile(filename.to_os_string()));
				had_err = true;
			}
			continue;
		}

		// Check if the path (potentially with trailing slash) resolves to root
		// This needs to happen before symlink_metadata to catch cases like "rootlink/"
		// where rootlink is a symlink to root.
		if uucore::fs::path_ends_with_terminator(file)
			&& options.recursive
			&& options.preserve_root
			&& let Some(root) = is_root_path(host, file)
		{
			show_preserve_root_error(host, file, &root);
			had_err = true;
			continue;
		}

		had_err = match host.fs().symlink_metadata(&host.resolve(file)) {
			Ok(metadata) => {
				// Create progress bar on first successful file metadata read
				if options.progress && progress_bar.is_none() {
					progress_bar = create_progress_bar(host, files, options.recursive);
				}

				any_files_processed = true;
				if metadata.is_dir() {
					handle_dir(host, file, options, progress_bar.as_ref())
				} else if is_symlink_dir(&metadata) {
					remove_dir(host, file, options, progress_bar.as_ref())
				} else {
					remove_file(host, file, options, progress_bar.as_ref())
				}
			},

			// GNU rm: -f ignores an operand that names no file, and nothing
			// else; any other reason it cannot be looked up is reported.
			Err(e) => !is_missing_under_force(&e, options) && show_removal_error(host, e, file),
		}
		.bitor(had_err);
	}

	// Only finish progress bar if it was created and files were processed
	if let Some(pb) = progress_bar
		&& any_files_processed
	{
		pb.finish();
	}

	had_err
}

/// Whether the given directory is empty.
///
/// `path` must be a directory. If there is an error reading the
/// contents of the directory, this returns `false`.
fn is_dir_empty(host: &mut Host, path: &Path) -> bool {
	host.fs()
		.read_dir(&host.resolve(path))
		.is_ok_and(|mut iter| iter.next().is_none())
}

#[cfg(unix)]
fn is_readable_metadata(metadata: &Metadata) -> bool {
	let mode = metadata.permissions().mode();
	(mode & 0o400) > 0
}

/// Whether the given file or directory is readable.
#[cfg(unix)]
fn is_readable(host: &mut Host, path: &Path) -> bool {
	host.fs()
		.metadata(&host.resolve(path))
		.is_ok_and(|metadata| is_readable_metadata(&metadata))
}

/// Whether the given file or directory is readable.
#[cfg(not(unix))]
fn is_readable(_host: &mut Host, _path: &Path) -> bool {
	true
}

#[cfg(unix)]
fn is_writable_metadata(metadata: &Metadata) -> bool {
	let mode = metadata.permissions().mode();
	(mode & 0o200) > 0
}

#[cfg(not(unix))]
fn is_writable_metadata(_metadata: &Metadata) -> bool {
	true
}

/// Removes `path`, and when it is a directory (not a symlink to one)
/// everything in it, as `rm -r` does with no prompt, and no output but the
/// errors it reports and, under `verbose`, `rm -v`'s `removed` lines; returns
/// whether it reported an error. A native tree goes through the descriptor
/// walk of [`safe_remove_dir_recursive`]. mv removes what a move across
/// filesystems copied with this, as GNU mv removes with rm's code.
#[cfg(all(feature = "util.mv", unix, not(target_os = "redox")))]
pub(crate) fn remove_moved(host: &mut Host, path: &Path, verbose: bool) -> bool {
	let options =
		Options { recursive: true, interactive: InteractiveMode::Never, verbose, ..Options::default() };
	remove_dir_recursive(host, path, &options, None)
}

/// Recursively remove the directory tree rooted at the given path.
///
/// If `path` is a file or a symbolic link, just remove it. If it is a
/// directory, remove all of its entries recursively and then remove the
/// directory itself. In case of an error, print the error message to
/// `stderr` and return `true`. If there were no errors, return `false`.
fn remove_dir_recursive(host: &mut Host, 
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	if host.is_cancelled() {
		return true;
	}

	// Base case 1: this is a file or a symbolic link.
	//
	// The symbolic link case is important because it could be a link to
	// a directory and we don't want to recurse. In particular, this
	// avoids an infinite recursion in the case of a link to the current
	// directory, like `ln -s . link`.
	let fs_path = host.resolve(path);
	if !host
		.fs()
		.symlink_metadata(&fs_path)
		.is_ok_and(|metadata| metadata.is_dir())
	{
		return remove_file(host, path, options, progress_bar);
	}

	remove_dir_tree(host, path, options, progress_bar)
}

/// Removes the directory `path`, known not to be a symlink to one, and
/// everything in it.
fn remove_dir_tree(host: &mut Host, path: &Path, options: &Options, progress_bar: Option<&ProgressBar>) -> bool {
	// Base case 2: this is a non-empty directory, but the user
	// doesn't want to descend into it.
	if options.interactive == InteractiveMode::Always && !is_dir_empty(host, path) && !prompt_descend(host, path)
	{
		return false;
	}

	// Native host trees use descriptor-relative traversal on Unix (except
	// Redox); every other filesystem is walked through its provider.
	#[cfg(all(unix, not(target_os = "redox")))]
	if host.fs().is_native_local(&host.resolve(path)) {
		return safe_remove_dir_recursive(host, path, options, progress_bar);
	}

	remove_dir_recursive_with_provider(host, path, options, progress_bar)
}

/// Removes the directory tree at `path` through the injected filesystem.
///
/// `path` must name a directory (not a symlink to one). Children are removed
/// by the type their listing reports, so prompts, verbose output and
/// progress apply per entry exactly as for top-level operands.
fn remove_dir_recursive_with_provider(
	host: &mut Host,
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	let filesystem = host.fs().clone();
	let fs_path = host.resolve(path);

	// Very long Windows paths are removed in one call.
	#[cfg(not(unix))]
	if path.to_str().is_some_and(|s| s.len() > 1000) {
		match filesystem.remove_dir_all(&fs_path) {
			Ok(()) => return false,
			// Something vanished under the call; the walk below removes
			// whatever is left, and finds nothing if the tree is gone.
			Err(e) if is_missing_under_force(&e, options) => {},
			Err(e) => return show_removal_error(host, e, path),
		}
	}

	let entries = match filesystem.read_dir(&fs_path) {
		Ok(entries) => entries,
		Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
			// An unreadable directory may still be empty and removable.
			match filesystem.remove_dir(&fs_path) {
				Ok(()) => {
					verbose_removed_directory(host, path, options);
					return false;
				},
				Err(gone) if is_missing_under_force(&gone, options) => return false,
				Err(_) => return show_permission_denied_error(host, path),
			}
		},
		Err(e) if is_missing_under_force(&e, options) => return false,
		Err(e) => return show_removal_error(host, e, path),
	};

	let mut error = false;
	for entry in entries {
		if host.is_cancelled() {
			return true;
		}
		match entry {
			Ok(entry) => {
				let child = child_path(path, &entry.file_name());
				// Only a real directory is descended into, never a symlink
				// or junction to one; an entry of unknown type is looked up.
				error |= match entry.file_type() {
					Ok(file_type) if file_type.is_dir() => remove_dir_tree(host, &child, options, progress_bar),
					Ok(_) => remove_file(host, &child, options, progress_bar),
					Err(_) => remove_dir_recursive(host, &child, options, progress_bar),
				};
			},
			Err(e) => {
				error |= report_unless_missing(host, e, path, options);
				break;
			},
		}
	}

	if error {
		// Children already reported their failures.
		return true;
	}

	if options.interactive == InteractiveMode::Always {
		// Ask the user whether to remove the current directory.
		if !prompt_dir(host, path, options) {
			return false;
		}
		// Children the user declined to remove keep the directory populated.
		if !is_dir_empty(host, path) {
			return false;
		}
	}

	if let Some(pb) = progress_bar {
		pb.inc(1);
	}
	remove_dir_with_special_cases(host, path, options, false)
}

/// Whether `path` is spelled as a filesystem root: `/` on the host, or a
/// virtual filesystem's `scheme://` root.
fn is_literal_root(path: &Path) -> bool {
	if is_virtual_path(path) {
		parent_path(path).is_none()
	} else {
		path.has_root() && path.parent().is_none()
	}
}

/// Check if a path resolves to a filesystem root.
/// Returns the root it resolves to, if any.
fn is_root_path(host: &mut Host, path: &Path) -> Option<PathBuf> {
	// Check simple case: literal root path
	if is_literal_root(path) {
		return Some(path.to_path_buf());
	}

	// Check if path resolves to a root after following symlinks
	host.fs()
		.canonicalize(host.resolve(path))
		.ok()
		.filter(|canonical| is_literal_root(canonical))
}

/// Show error message for attempting to remove root.
fn show_preserve_root_error(host: &mut Host, path: &Path, root: &Path) {
	if is_literal_root(path) {
		if is_virtual_path(path) {
			show_error!(host, "it is dangerous to operate recursively on {}", path.quote());
		} else {
			// Path is literally "/"
			show_error!(host, "{}", RmError::DangerousRecursiveOperation);
		}
	} else if is_virtual_path(root) {
		show_error!(
			host,
			"it is dangerous to operate recursively on '{}' (same as '{}')",
			path.display(),
			root.display()
		);
	} else {
		// Path resolves to root but isn't literally "/" (e.g., symlink to /)
		show_error!(host, "it is dangerous to operate recursively on '{}' (same as '/')", path.display());
	}
	show_error!(host, "{}", RmError::UseNoPreserveRoot);
}

fn handle_dir(host: &mut Host, path: &Path, options: &Options, progress_bar: Option<&ProgressBar>) -> bool {
	let mut had_err = false;

	let path = clean_trailing_slashes(path);
	if path_is_current_or_parent_directory(path) {
		show_error!(host, "{}", RmError::RefusingToRemoveDirectory(path.as_os_str().to_os_string()));
		return true;
	}

	let root = is_root_path(host, path);
	let is_root = root.is_some();
	if options.recursive && (!is_root || !options.preserve_root) {
		had_err = remove_dir_recursive(host, path, options, progress_bar);
	} else if options.dir && (!is_root || !options.preserve_root) {
		had_err = remove_dir(host, path, options, progress_bar).bitor(had_err);
	} else if let Some(root) = root.filter(|_| options.recursive) {
		show_preserve_root_error(host, path, &root);
		had_err = true;
	} else {
		show_error!(host, "{}", RmError::CannotRemoveIsDirectory(path.as_os_str().to_os_string()));
		had_err = true;
	}

	had_err
}

/// Remove the given directory, asking the user for permission if necessary.
///
/// Returns true if it has encountered an error.
fn remove_dir(host: &mut Host, path: &Path, options: &Options, progress_bar: Option<&ProgressBar>) -> bool {
	// Ask the user for permission.
	if !prompt_dir(host, path, options) {
		return false;
	}

	// Called to remove a symlink_dir (windows) without "-r"/"-R" or "-d".
	if !options.dir && !options.recursive {
		show_error!(host, "{}", RmError::CannotRemoveIsDirectory(path.as_os_str().to_os_string()));
		return true;
	}

	// Use safe traversal on Unix (except Redox) for empty directory removal
	#[cfg(all(unix, not(target_os = "redox")))]
	{
		if let Some(result) = safe_remove_empty_dir(host, path, options, progress_bar) {
			return result;
		}
	}

	// Update progress bar for directory removal
	if let Some(pb) = progress_bar {
		pb.inc(1);
	}

	// Fallback method for non-Linux or when safe traversal is unavailable
	remove_dir_with_feedback(host, path, options)
}

fn remove_file(host: &mut Host, path: &Path, options: &Options, progress_bar: Option<&ProgressBar>) -> bool {
	if prompt_file(host, path, options) {
		// Update progress bar before removing the file
		if let Some(pb) = progress_bar {
			pb.inc(1);
		}

		// Use safe traversal on Unix (except Redox) for individual file removal
		#[cfg(all(unix, not(target_os = "redox")))]
		{
			if let Some(result) = safe_remove_file(host, path, options, progress_bar) {
				return result;
			}
		}

		// Provider removal for non-native paths, non-Unix, Redox, or when safe
		// traversal is unavailable
		match host.fs().remove_file(&host.resolve(path)) {
			Ok(_) => {
				verbose_removed_file(host, path, options);
			},
			Err(e) if is_missing_under_force(&e, options) => {},
			Err(e) => {
				if e.kind() == io::ErrorKind::PermissionDenied {
					// GNU compatibility (rm/fail-eacces.sh)
					show_error!(host, 
						"{}",
						RmError::CannotRemovePermissionDenied(path.as_os_str().to_os_string())
					);
				} else {
					return show_removal_error(host, e, path);
				}
				return true;
			},
		}
	}

	false
}

fn prompt_dir(host: &mut Host, path: &Path, options: &Options) -> bool {
	// If interactive is Never we never want to send prompts
	if options.interactive == InteractiveMode::Never {
		return true;
	}

	// We can't use metadata.permissions.readonly for directories because it only
	// works on files So we have to handle whether a directory is writable manually
	if let Ok(metadata) = host.fs().metadata(&host.resolve(path)) {
		handle_writable_directory(host, path, options, &metadata)
	} else {
		true
	}
}

fn prompt_file(host: &mut Host, path: &Path, options: &Options) -> bool {
	// If interactive is Never we never want to send prompts, and the
	// default mode only asks about write-protected files on a terminal.
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	if options.interactive == InteractiveMode::Never
		|| (options.interactive == InteractiveMode::PromptProtected && !stdin_ok)
	{
		return true;
	}

	let Ok(metadata) = host.fs().symlink_metadata(&host.resolve(path)) else {
		return true;
	};

	if metadata.is_symlink() {
		return options.interactive != InteractiveMode::Always
			|| prompt_yes!(host, "remove symbolic link {}?", path.quote());
	}

	if options.interactive == InteractiveMode::Always && is_writable_metadata(&metadata) {
		return if metadata.len() == 0 {
			prompt_yes!(host, "remove regular empty file {}?", path.quote())
		} else {
			prompt_yes!(host, "remove file {}?", path.quote())
		};
	}

	prompt_file_permission_readonly(host, path, options, &metadata)
}

fn prompt_file_permission_readonly(host: &mut Host, path: &Path, options: &Options, metadata: &Metadata) -> bool {
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	match (stdin_ok, options.interactive) {
		(false, InteractiveMode::PromptProtected) => true,
		_ if is_writable_metadata(metadata) => true,
		_ if metadata.len() == 0 => {
			prompt_yes!(host, "remove write-protected regular empty file {}?", path.quote())
		},
		_ => prompt_yes!(host, "remove write-protected regular file {}?", path.quote()),
	}
}

/// Checks if the path is referring to current or parent directory , if it is
/// referring to current or any parent directory in the file tree e.g  '/../..'
/// , '../..'. A Windows drive-relative operand counts by its remainder: `C:`
/// alone names that drive's current directory, so it is refused like `.`.
fn path_is_current_or_parent_directory(path: &Path) -> bool {
	let mut components = path.components();
	if let Some(Component::Prefix(prefix)) = components.next()
		&& matches!(prefix.kind(), Prefix::Disk(_))
		&& !path.has_root()
	{
		let rest = components.as_path();
		return rest.is_empty() || path_is_current_or_parent_directory(rest);
	}
	let path_str = os_bytes(path.as_os_str());
	let dir_separator = MAIN_SEPARATOR as u8;
	if let Some(path_bytes) = path_str {
		return path_bytes == *b"."
			|| path_bytes == ([b'.', dir_separator])
			|| path_bytes == *b".."
			|| path_bytes == ([b'.', b'.', dir_separator])
			|| path_bytes.ends_with(&[dir_separator, b'.'])
			|| path_bytes.ends_with(&[dir_separator, b'.', b'.'])
			|| path_bytes.ends_with(&[dir_separator, b'.', dir_separator])
			|| path_bytes.ends_with(&[dir_separator, b'.', b'.', dir_separator]);
	}
	false
}

// For directories finding if they are writable or not is a hassle. In Unix we
// can use the built-in rust crate to check mode bits. But other os don't have
// something similar afaik Most cases are covered by keep eye out for edge cases
#[cfg(unix)]
fn handle_writable_directory(host: &mut Host, path: &Path, options: &Options, metadata: &Metadata) -> bool {
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	match (
		stdin_ok,
		is_readable_metadata(metadata),
		is_writable_metadata(metadata),
		options.interactive,
	) {
		(false, _, _, InteractiveMode::PromptProtected) => true,
		(false, false, false, InteractiveMode::Never) => true, /* Don't prompt when interactive is */
		// never
		(_, false, false, _) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, false, true, InteractiveMode::Always) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, true, false, _) => prompt_yes!(host, "remove write-protected directory {}?", path.quote()),
		(_, _, _, InteractiveMode::Always) => prompt_yes!(host, "remove directory {}?", path.quote()),
		(..) => true,
	}
}

// For windows we can use windows metadata trait and file attributes to see if a
// directory is readonly
#[cfg(windows)]
fn handle_writable_directory(host: &mut Host, path: &Path, options: &Options, metadata: &Metadata) -> bool {
	// Native Windows permissions mirror FILE_ATTRIBUTE_READONLY.
	let not_user_writable = metadata.permissions().readonly();
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	match (stdin_ok, not_user_writable, options.interactive) {
		(false, _, InteractiveMode::PromptProtected) => true,
		(_, true, _) => prompt_yes!(host, "remove write-protected directory {}?", path.quote()),
		(_, _, InteractiveMode::Always) => prompt_yes!(host, "remove directory {}?", path.quote()),
		(..) => true,
	}
}

// I have this here for completeness but it will always return "remove directory
// {}" because metadata.permissions().readonly() only works for file not
// directories
#[cfg(not(windows))]
#[cfg(not(unix))]
fn handle_writable_directory(host: &mut Host, path: &Path, options: &Options, _metadata: &Metadata) -> bool {
	if options.interactive == InteractiveMode::Always {
		prompt_yes!(host, "remove directory {}?", path.quote())
	} else {
		true
	}
}

/// Removes trailing slashes, for example 'd/../////' yield 'd/../' required to
/// fix rm-r4 GNU test
fn clean_trailing_slashes(path: &Path) -> &Path {
	// A virtual root (`scheme://`) keeps both slashes of its authority marker.
	if is_virtual_path(path) && parent_path(path).is_none() {
		return path;
	}
	let path_str = os_bytes(path.as_os_str());
	let dir_separator = MAIN_SEPARATOR as u8;

	if let Some(path_bytes) = path_str {
		let mut idx = if path_bytes.len() > 1 {
			path_bytes.len() - 1
		} else {
			return path;
		};
		// Checks if element at the end is a '/'
		if path_bytes[idx] == dir_separator {
			for i in (1..path_bytes.len()).rev() {
				// Will break at the start of the continuous sequence of '/', eg: "abc//////" ,
				// will break at "abc/", this will clean ////// to the root '/', so we have
				// to be careful to not delete the root.
				if path_bytes[i - 1] != dir_separator {
					idx = i;
					break;
				}
			}
			#[cfg(unix)]
			return Path::new(OsStr::from_bytes(&path_bytes[0..=idx]));

			#[cfg(not(unix))]
			// `os_bytes` returns `None` for non-UTF-8 strings off Unix, so this
			// byte slice is valid UTF-8.
			return Path::new(std::str::from_utf8(&path_bytes[0..=idx]).unwrap());
		}
	}
	path
}

fn prompt_descend(host: &mut Host, path: &Path) -> bool {
	prompt_yes!(host, "descend into directory {}?", path.quote())
}

#[cfg(not(windows))]
fn is_symlink_dir(_metadata: &Metadata) -> bool {
	false
}

#[cfg(windows)]
fn is_symlink_dir(metadata: &Metadata) -> bool {
	metadata.file_type().is_symlink_dir()
}

#[cfg(test)]
mod tests {
	use std::{
		path::Path,
		sync::atomic::{AtomicBool, Ordering},
	};

	use clap::Parser;
	use tempfile::{Builder, tempdir};

	use super::{Rm, clean_trailing_slashes};
	use crate::host::{Host, Utility, run_util};

	/// How many tests each of the swapping runs is split into. Each piece is a
	/// test of its own with its own bound in `.config/nextest.toml`: a run of
	/// the whole binary then reports a result every piece, and the gate's
	/// runner, which fails the tests it is running once nothing has been
	/// reported for the longest bound among them, sees progress while the
	/// swapping goes on. The whole 2,000 runs took up to 922 s on runc beside
	/// 64 busy loops, reporting nothing until they ended.
	#[cfg(unix)]
	const SWAP_PIECES: usize = 4;

	/// Runs `rm -r root` a piece of 2,000 times while `swapped`, the operand
	/// `root` or `root/sub`, flips between a directory and a symlink to
	/// `outside/`. Returns how many runs removed a file in `outside/`.
	#[cfg(unix)]
	fn rm_r_while_swapping(swapped: &str, piece: usize) -> usize {
		const RUNS: usize = 2_000;
		let runs = RUNS / SWAP_PIECES;
		let (mut escapes, mut refusals) = (0, 0);
		for _ in 0..runs {
			let cwd = tempdir().unwrap();
			let (parked, outside) = (cwd.path().join("parked"), cwd.path().join("outside"));
			let (sub, flipped) = (cwd.path().join("root/sub"), cwd.path().join(swapped));
			std::fs::create_dir_all(&sub).unwrap();
			std::fs::create_dir_all(&outside).unwrap();
			for i in 0..4 {
				std::fs::write(sub.join(format!("in{i}")), b"").unwrap();
				std::fs::write(outside.join(format!("victim{i}")), b"").unwrap();
			}
			let stop = AtomicBool::new(false);
			let err = std::thread::scope(|scope| {
				scope.spawn(|| {
					while !stop.load(Ordering::Relaxed) {
						if std::fs::rename(&flipped, &parked).is_err() {
							std::thread::yield_now();
							continue;
						}
						let _ = std::os::unix::fs::symlink(&outside, &flipped);
						for _ in 0..50 {
							std::hint::spin_loop();
						}
						let _ = std::fs::remove_file(&flipped);
						let _ = std::fs::rename(&parked, &flipped);
					}
				});
				let (_, capture) = run_util::<Rm>(&["-r", "root"], "", cwd.path());
				stop.store(true, Ordering::Relaxed);
				capture.err()
			});
			if (0..4).any(|i| !outside.join(format!("victim{i}")).exists()) {
				escapes += 1;
			}
			if err.contains("Not a directory") || err.contains("symbolic links") {
				refusals += 1;
			}
		}
		eprintln!(
			"piece {} of {SWAP_PIECES}, {runs} of {RUNS} runs swapping {swapped}: {escapes} removed a file outside the \
			 tree, {refusals} refused the swapped directory",
			piece + 1
		);
		escapes
	}

	/// `rm -r root` removes nothing outside `root` while `root/sub` flips
	/// between a directory and a symlink to `outside/`, 2,000 times. A kernel
	/// that refuses the symlink at the directory open passes this as it is;
	/// gVisor before release-20261109.0, which follows a symlink to a
	/// directory despite `O_NOFOLLOW` when `O_DIRECTORY` is set
	/// (google/gvisor#14786), passes it only because rm keeps no directory but
	/// the one it stat'd.
	#[cfg(unix)]
	#[test]
	fn recursive_removal_deletes_nothing_through_a_directory_swapped_for_a_symlink_1() {
		let escapes = rm_r_while_swapping("root/sub", 0);
		assert_eq!(escapes, 0, "rm -r removed files outside the tree through a swapped symlink");
	}

	#[cfg(unix)]
	#[test]
	fn recursive_removal_deletes_nothing_through_a_directory_swapped_for_a_symlink_2() {
		let escapes = rm_r_while_swapping("root/sub", 1);
		assert_eq!(escapes, 0, "rm -r removed files outside the tree through a swapped symlink");
	}

	#[cfg(unix)]
	#[test]
	fn recursive_removal_deletes_nothing_through_a_directory_swapped_for_a_symlink_3() {
		let escapes = rm_r_while_swapping("root/sub", 2);
		assert_eq!(escapes, 0, "rm -r removed files outside the tree through a swapped symlink");
	}

	#[cfg(unix)]
	#[test]
	fn recursive_removal_deletes_nothing_through_a_directory_swapped_for_a_symlink_4() {
		let escapes = rm_r_while_swapping("root/sub", 3);
		assert_eq!(escapes, 0, "rm -r removed files outside the tree through a swapped symlink");
	}

	/// The same while the operand `root` itself flips. rm checks the operand
	/// with `lstat`, so on every kernel it must not open a symlink put there
	/// since.
	#[cfg(unix)]
	#[test]
	fn recursive_removal_deletes_nothing_through_an_operand_swapped_for_a_symlink_1() {
		let escapes = rm_r_while_swapping("root", 0);
		assert_eq!(escapes, 0, "rm -r removed files outside the operand through a swapped symlink");
	}

	#[cfg(unix)]
	#[test]
	fn recursive_removal_deletes_nothing_through_an_operand_swapped_for_a_symlink_2() {
		let escapes = rm_r_while_swapping("root", 1);
		assert_eq!(escapes, 0, "rm -r removed files outside the operand through a swapped symlink");
	}

	#[cfg(unix)]
	#[test]
	fn recursive_removal_deletes_nothing_through_an_operand_swapped_for_a_symlink_3() {
		let escapes = rm_r_while_swapping("root", 2);
		assert_eq!(escapes, 0, "rm -r removed files outside the operand through a swapped symlink");
	}

	#[cfg(unix)]
	#[test]
	fn recursive_removal_deletes_nothing_through_an_operand_swapped_for_a_symlink_4() {
		let escapes = rm_r_while_swapping("root", 3);
		assert_eq!(escapes, 0, "rm -r removed files outside the operand through a swapped symlink");
	}

	/// GNU rm -f (remove.c, `nonexistent_file_errno`) ignores ENOENT, ENOTDIR,
	/// EINVAL and EILSEQ, and nothing else; without -f it ignores none of them.
	#[cfg(unix)]
	#[test]
	fn force_ignores_what_gnu_counts_as_nonexistent() {
		let force = super::Options { force: true, interactive: super::InteractiveMode::Never, ..super::Options::default() };
		let plain = super::Options { force: false, interactive: super::InteractiveMode::Never, ..super::Options::default() };
		for (errno, ignored) in [
			(libc::ENOENT, true),
			(libc::ENOTDIR, true),
			(libc::EINVAL, true),
			(libc::EILSEQ, true),
			(libc::EACCES, false),
			(libc::ELOOP, false),
			(libc::ENAMETOOLONG, false),
			(libc::EMFILE, false),
		] {
			let e = std::io::Error::from_raw_os_error(errno);
			assert_eq!(super::is_missing_under_force(&e, &force), ignored, "-f, errno {errno}: {e}");
			assert!(!super::is_missing_under_force(&e, &plain), "no -f, errno {errno}: {e}");
		}
	}

	/// rm -r keeps a directory put in place of the subdirectory it stat'd, an
	/// empty one too: the identity check refuses it (`ENOTDIR`), and rm then
	/// removes nothing at that name.
	#[cfg(unix)]
	#[test]
	fn an_empty_directory_swapped_in_after_the_stat_is_kept() {
		const TREE: &str = "rm-seam-empty-swap";
		let cwd = tempdir().unwrap();
		let tree = cwd.path().join(TREE);
		std::fs::create_dir_all(tree.join("sub")).unwrap();
		std::fs::write(tree.join("sub/in"), b"").unwrap();
		let other = cwd.path().join("other");
		std::fs::create_dir(&other).unwrap();
		let ran = std::sync::Arc::new(AtomicBool::new(false));
		let (sub, parked, seen) = (tree.join("sub"), cwd.path().join("parked"), std::sync::Arc::clone(&ran));
		crate::host::hook_at(Path::new(TREE).join("sub"), move || {
			std::fs::rename(&sub, &parked).unwrap();
			std::fs::rename(&other, &sub).unwrap();
			seen.store(true, Ordering::SeqCst);
		});
		let (code, capture) = run_util::<Rm>(&["-r", TREE], "", cwd.path());
		let err = capture.err();
		assert!(ran.load(Ordering::SeqCst), "the swap at rm's seam did not run: ({code}, {err:?})");
		assert!(tree.join("sub").is_dir(), "removed a directory that was not the one it stat'd: ({code}, {err:?})");
		assert_eq!(code, 1, "{err}");
		assert!(err.starts_with("rm: cannot remove 'rm-seam-empty-swap/sub': Not a directory"), "{err}");
	}

	/// The same for the operand: rm -r keeps an empty directory put in its
	/// place after the lstat and reports it; rm -rf keeps it silently, as `-f`
	/// ignores ENOTDIR.
	#[cfg(unix)]
	#[test]
	fn an_empty_directory_swapped_in_for_the_operand_after_the_lstat_is_kept() {
		const OPERAND: &str = "rm-seam-empty-operand";
		for (flags, want_code, want_err) in
			[("-r", 1, "rm: cannot remove 'rm-seam-empty-operand': Not a directory"), ("-rf", 0, "")]
		{
			let cwd = tempdir().unwrap();
			let operand = cwd.path().join(OPERAND);
			std::fs::create_dir(&operand).unwrap();
			std::fs::write(operand.join("in"), b"").unwrap();
			let other = cwd.path().join("other");
			std::fs::create_dir(&other).unwrap();
			let ran = std::sync::Arc::new(AtomicBool::new(false));
			let (moved, parked, seen) = (operand.clone(), cwd.path().join("parked"), std::sync::Arc::clone(&ran));
			crate::host::hook_at(Path::new(OPERAND).to_path_buf(), move || {
				std::fs::rename(&moved, &parked).unwrap();
				std::fs::rename(&other, &moved).unwrap();
				seen.store(true, Ordering::SeqCst);
			});
			let (code, capture) = run_util::<Rm>(&[flags, OPERAND], "", cwd.path());
			let err = capture.err();
			assert!(ran.load(Ordering::SeqCst), "{flags}: the swap at rm's seam did not run: ({code}, {err:?})");
			assert!(operand.is_dir(), "{flags}: removed a directory that was not the one it lstat'd: ({code}, {err:?})");
			assert!(cwd.path().join("parked/in").exists(), "{flags}: touched the directory it lstat'd: ({code}, {err:?})");
			assert_eq!((code, err.trim_end()), (want_code, want_err), "{flags}");
		}
	}

	#[test]
	fn collapses_repeated_root_slashes() {
		assert_eq!(Path::new("/"), clean_trailing_slashes(Path::new("/////")));
	}

	#[test]
	fn empty_operand_does_not_delete_cwd() {
		let cwd = tempdir().unwrap();
		let sentinel = cwd.path().join("sentinel");
		std::fs::write(&sentinel, b"keep me").unwrap();

		let (code, _) = run_util::<Rm>(&["-rf", ""], "", cwd.path());

		assert_eq!(code, 0);
		assert!(cwd.path().is_dir());
		assert!(sentinel.is_file());
	}

	#[test]
	fn relative_operand_resolves_against_host_cwd() {
		let cwd = tempdir().unwrap();
		let process_cwd = std::env::current_dir().unwrap();
		let process_file = Builder::new()
			.prefix("pi-rm-relative-")
			.tempfile_in(process_cwd)
			.unwrap();
		let name = process_file.path().file_name().unwrap().to_str().unwrap();
		let host_file = cwd.path().join(name);
		std::fs::write(&host_file, b"remove me").unwrap();

		let (code, capture) = run_util::<Rm>(&[name], "", cwd.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert!(!host_file.exists());
		assert!(process_file.path().exists());
	}

	#[cfg(windows)]
	#[test]
	fn drive_relative_operands_resolve_against_host_cwd() {
		let cwd = tempdir().unwrap();
		let sentinel = cwd.path().join("sentinel");
		std::fs::write(&sentinel, b"keep me").unwrap();
		std::fs::create_dir(cwd.path().join("child")).unwrap();
		// `C:` for a cwd of `C:\...`.
		let drive = cwd.path().components().next().unwrap().as_os_str().to_str().unwrap().to_owned();

		let (code, capture) = run_util::<Rm>(&["-rf", drive.as_str()], "", cwd.path());
		assert_eq!(code, 1);
		assert!(capture.err().contains("refusing to remove '.' or '..' directory"), "{}", capture.err());
		assert!(sentinel.is_file());

		let child = format!("{drive}child");
		let (code, capture) = run_util::<Rm>(&["-r", child.as_str()], "", cwd.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert!(!cwd.path().join("child").exists());
		assert!(sentinel.is_file());
	}

	#[test]
	fn recursively_removes_directory_tree() {
		let cwd = tempdir().unwrap();
		std::fs::create_dir_all(cwd.path().join("tree/child")).unwrap();
		std::fs::write(cwd.path().join("tree/child/file"), b"data").unwrap();

		let (code, capture) = run_util::<Rm>(&["-r", "tree"], "", cwd.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert!(!cwd.path().join("tree").exists());
	}

	#[test]
	fn interactive_no_keeps_file_and_prompts_on_stderr() {
		let cwd = tempdir().unwrap();
		std::fs::write(cwd.path().join("keep"), b"data").unwrap();

		let (code, capture) = run_util::<Rm>(&["-i", "keep"], "n\n", cwd.path());

		assert_eq!(code, 0);
		assert!(cwd.path().join("keep").exists());
		assert_eq!(capture.out(), "");
		assert!(capture.err().contains("rm: remove file 'keep'?"));
	}

	#[test]
	fn refuses_abbreviated_no_preserve_root() {
		let (code, capture) = run_util::<Rm>(&["--no-preserve-roo", "-rf", "/"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(
			capture.err(),
			"rm: you may not abbreviate the --no-preserve-root option\n"
		);
	}
	#[test]
	fn abbreviated_spelling_after_option_terminator_is_an_operand() {
		let cwd = tempdir().unwrap();
		let file = cwd.path().join("--no-preserve-roo");
		std::fs::write(&file, b"data").unwrap();

		let (code, capture) = run_util::<Rm>(&["--", "--no-preserve-roo"], "", cwd.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert!(!file.exists());
	}


	#[test]
	fn preserve_root_refuses_recursive_root_removal() {
		let (code, capture) = run_util::<Rm>(&["-rf", "/"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("it is dangerous to operate recursively on '/'"));
		assert!(capture.err().contains("use --no-preserve-root to override this failsafe"));
	}

	#[test]
	fn missing_operand_is_an_error_unless_forced() {
		let (code, capture) = run_util::<Rm>(&[], "", "/");
		assert_eq!(code, 1);
		assert_eq!(
			capture.err(),
			"rm: missing operand\nTry 'rm --help' for more information.\n"
		);

		let (code, capture) = run_util::<Rm>(&["-f"], "", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn cancellation_stops_a_recursive_removal_midway() {
		let cwd = tempdir().unwrap();
		let tree = cwd.path().join("tree");
		for i in 0..3000 {
			let dir = tree.join(format!("d{i:04}"));
			std::fs::create_dir_all(&dir).unwrap();
			std::fs::write(dir.join("f"), b"").unwrap();
		}
		// rm walks in listing order, so the first listed child goes first;
		// cancelling the moment it is gone must leave most of the tree.
		let first = std::fs::read_dir(&tree).unwrap().next().unwrap().unwrap().path();
		let (mut host, _capture) = Host::for_test(Rm::NAME, "", cwd.path());
		let cancel = host.cancel_flag_for_test();
		let done = AtomicBool::new(false);
		let rm = Rm::try_parse_from(["rm", "-rf", "tree"]).unwrap();

		let code = std::thread::scope(|scope| {
			scope.spawn(|| {
				while first.exists() && !done.load(Ordering::Relaxed) {}
				cancel.store(true, Ordering::Relaxed);
			});
			let code = rm.run(&mut host);
			done.store(true, Ordering::Relaxed);
			code
		});

		assert_eq!(code, 1);
		assert!(tree.is_dir(), "rm ran to completion despite cancellation");
	}

	// Unix only: Windows reports a file another process is already deleting
	// (delete pending) as access denied, not as gone, so the race still
	// surfaces there.
	#[cfg(unix)]
	#[test]
	fn concurrent_forced_removals_both_succeed() {
		let cwd = tempdir().unwrap();
		let tree = cwd.path().join("tree");
		for i in 0..3000 {
			let dir = tree.join(format!("d{i:04}"));
			std::fs::create_dir_all(&dir).unwrap();
			std::fs::write(dir.join("f"), b"").unwrap();
		}
		let start = std::sync::Barrier::new(2);
		let remove = || {
			start.wait();
			let (code, capture) = run_util::<Rm>(&["-rf", "tree"], "", cwd.path());
			(code, capture.err())
		};

		// Both walks race over the same entries; under -f an entry the other
		// one removed first is already gone, which is success.
		let (a, b) = std::thread::scope(|scope| {
			let a = scope.spawn(remove);
			let b = scope.spawn(remove);
			(a.join().unwrap(), b.join().unwrap())
		});

		assert_eq!(a, (0, String::new()));
		assert_eq!(b, (0, String::new()));
		assert!(!tree.exists());
	}

	/// Answers every prompt "y", deleting `path` first, as another process
	/// might while the prompt waits.
	#[derive(Clone)]
	struct DeleteThenYes {
		path:    std::path::PathBuf,
		pending: std::collections::VecDeque<u8>,
	}

	impl std::io::Read for DeleteThenYes {
		fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
			if self.pending.is_empty() {
				let _ = std::fs::remove_file(&self.path);
				self.pending.extend(b"y\n");
			}
			buf[0] = self.pending.pop_front().unwrap();
			Ok(1)
		}
	}

	impl std::io::Write for DeleteThenYes {
		fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
			Err(std::io::ErrorKind::Unsupported.into())
		}

		fn flush(&mut self) -> std::io::Result<()> {
			Ok(())
		}
	}

	impl crate::openfile::Stream for DeleteThenYes {}

	#[test]
	fn interactive_after_force_still_reports_a_vanished_file() {
		// GNU rm: a later -i cancels -f's "ignore missing files"; an earlier
		// one is overridden by -f, which removes without asking.
		for (flags, expected) in [("-fi", 1), ("-if", 0)] {
			let cwd = tempdir().unwrap();
			let file = cwd.path().join("file");
			std::fs::write(&file, b"").unwrap();
			let stdin = Box::new(DeleteThenYes { path: file.clone(), pending: Default::default() });
			let (mut host, capture) = Host::for_test_with_stdin(Rm::NAME, stdin, cwd.path());
			let code = Rm::try_parse_from(["rm", flags, "file"]).unwrap().run(&mut host);

			assert_eq!(code, expected, "{flags}: {}", capture.err());
			assert!(!file.exists(), "{flags}");
			if expected == 1 {
				assert!(capture.err().contains("cannot remove 'file'"), "{flags}: {}", capture.err());
			}
		}
	}

	/// A directory chain deeper than the removal could recurse through on a
	/// small stack, whose paths pass `PATH_MAX`, and which one descriptor per
	/// level would take past the open-file limit of 32 the test sets in a
	/// process of its own. Every level also holds a file, so the walk keeps
	/// listing a directory after coming back up out of its subdirectory.
	/// Redox removes through the provider walk rather than the descriptor
	/// walk, so it is not covered.
	///
	/// 400 levels: before rm's walk kept its directories on a stack of its
	/// own, it recursed once per level and overflowed a 256 KiB stack from
	/// 201 levels. Keep the chain shallow beyond that: on macOS every file
	/// operation slows with its directory's depth, so building and removing
	/// the chain grows quadratically, and 5,000 levels took over five
	/// minutes; and a Bazel server that removed a chain of 1,215 levels left
	/// in its sandbox died.
	#[cfg(all(unix, not(target_os = "redox")))]
	#[test]
	fn removes_a_directory_chain_deeper_than_the_stack() {
		use std::ffi::OsStr;

		use uucore::safe_traversal::{DirFd, SymlinkBehavior};

		if !crate::own_process::own_process() {
			return;
		}
		const DEPTH: usize = 400;
		const NAME: &str = "level-of-the-chain";
		const { assert!(DEPTH * (NAME.len() + 1) > libc::PATH_MAX as usize) };
		let cwd = crate::deep_tree::tempdir();
		let root = cwd.path().join("deep");
		// Whatever rm leaves is removed before `cwd` drops, whose
		// `remove_dir_all` would hold one descriptor per level of the chain.
		let _chain = crate::deep_tree::RemoveTree(root.clone());
		std::fs::create_dir(&root).unwrap();
		let mut dir = DirFd::open(&root, SymlinkBehavior::NoFollow).unwrap();
		for _ in 0..DEPTH {
			dir.open_file_at(OsStr::new("f")).unwrap();
			dir.mkdir_at(OsStr::new(NAME), 0o755).unwrap();
			dir = dir.open_subdir(OsStr::new(NAME), SymlinkBehavior::NoFollow).unwrap();
		}
		drop(dir);
		crate::deep_tree::limit_descriptors(32);

		let cwd_path = cwd.path().to_path_buf();
		let (code, err) = std::thread::Builder::new()
			.stack_size(256 * 1024)
			.spawn(move || {
				let (code, capture) = run_util::<Rm>(&["-rf", "deep"], "", cwd_path);
				(code, capture.err())
			})
			.unwrap()
			.join()
			.unwrap();

		assert_eq!((code, err.as_str()), (0, ""));
		assert!(!root.exists(), "rm -rf left the chain behind");
	}

	/// A directory bind-mounted inside itself is a cycle: rm must report it
	/// with GNU's warning and leave the tree, instead of descending into it.
	///
	/// Ignored by default because it needs the privilege to bind-mount: run it
	/// as root with `--ignored`. Without the mount there is no cycle, so a
	/// silent early return would report a pass that proves nothing.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "bind-mounts a directory; run as root with --ignored"]
	fn reports_a_directory_that_is_its_own_ancestor() {
		let cwd = tempdir().unwrap();
		let loop_dir = cwd.path().join("a/d/loop");
		std::fs::create_dir_all(&loop_dir).unwrap();
		let mounted = std::process::Command::new("mount")
			.arg("--bind")
			.arg(cwd.path().join("a"))
			.arg(&loop_dir)
			.stderr(std::process::Stdio::null())
			.status()
			.is_ok_and(|status| status.success());
		assert!(mounted, "mount --bind failed: run this test as root");

		let (code, capture) = run_util::<Rm>(&["-rf", "a"], "", cwd.path());
		let unmounted = std::process::Command::new("umount").arg(&loop_dir).status();

		assert_eq!(code, 1);
		assert_eq!(
			capture.err(),
			"rm: WARNING: Circular directory structure.\nThis almost certainly means that you have a \
			 corrupted file system.\nNOTIFY YOUR SYSTEM MANAGER.\nThe following directory is part of \
			 the cycle:\n  a/d/loop\n\n"
		);
		assert!(unmounted.is_ok_and(|status| status.success()));
	}

	#[cfg(unix)]
	#[test]
	fn unremovable_entry_is_reported_once_and_the_rest_removed() {
		use std::os::unix::fs::PermissionsExt;

		let run = |flags: &str| {
			let cwd = tempdir().unwrap();
			let locked = cwd.path().join("tree/locked");
			std::fs::create_dir_all(&locked).unwrap();
			std::fs::write(locked.join("file"), b"").unwrap();
			std::fs::write(cwd.path().join("tree/other"), b"").unwrap();
			std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
			// A privileged user writes into it regardless; nothing to test then.
			if std::fs::write(locked.join("probe"), b"").is_ok() {
				return None;
			}

			let (code, capture) = run_util::<Rm>(&[flags, "tree"], "", cwd.path());
			std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

			assert!(locked.join("file").exists(), "{flags}");
			assert!(!cwd.path().join("tree/other").exists(), "{flags}");
			Some((code, capture.err()))
		};
		let Some((code, err)) = run("-rf") else {
			eprintln!("skipped: this user writes into a directory of mode 555 (root), so nothing is unremovable");
			return;
		};

		assert_eq!(code, 1);
		assert_eq!(err.lines().count(), 1, "{err}");
		assert!(err.starts_with("rm: cannot remove 'tree/locked/file': Permission denied"), "{err}");
		// Without -f (and without a terminal to prompt on) the removal must
		// report exactly the same.
		assert_eq!(run("-r"), Some((code, err)));
	}

	/// GNU rm -f ignores an operand that names no file, here a missing name or
	/// a path through a file; without -f each is reported under its own
	/// reason.
	#[cfg(unix)]
	#[test]
	fn missing_entries_are_silent_only_under_force() {
		let cwd = tempdir().unwrap();
		std::fs::write(cwd.path().join("file"), b"").unwrap();
		let run = |args: &[&str]| {
			let (code, capture) = run_util::<Rm>(args, "", cwd.path());
			(code, capture.err())
		};

		for flags in ["-f", "-rf"] {
			for operand in ["missing", "file/x"] {
				assert_eq!(run(&[flags, operand]), (0, String::new()), "{flags} {operand}");
			}
		}
		assert_eq!(run(&["missing"]), (1, "rm: cannot remove 'missing': No such file or directory\n".to_owned()));
		assert_eq!(run(&["file/x"]), (1, "rm: cannot remove 'file/x': Not a directory\n".to_owned()));
		assert!(cwd.path().join("file").is_file());
	}

	/// GNU rm reports an operand in a directory it may not search under that
	/// reason, with -f or without: -f ignores only an operand that is gone. A
	/// directory it may not read is removed if it is empty, and reported if
	/// not.
	#[cfg(unix)]
	#[test]
	fn force_reports_what_it_may_not_look_up_or_read() {
		use std::os::unix::fs::PermissionsExt;

		let cwd = tempdir().unwrap();
		let dirs = ["locked", "tree/empty", "tree/full"];
		for dir in dirs {
			std::fs::create_dir_all(cwd.path().join(dir)).unwrap();
		}
		std::fs::write(cwd.path().join("locked/x"), b"").unwrap();
		std::fs::write(cwd.path().join("tree/full/f"), b"").unwrap();
		let set_mode = |mode| {
			for dir in dirs {
				let _ = std::fs::set_permissions(cwd.path().join(dir), std::fs::Permissions::from_mode(mode));
			}
		};
		set_mode(0o000);
		// A privileged user searches and reads them regardless; nothing to test then.
		if std::fs::symlink_metadata(cwd.path().join("locked/x")).is_ok() {
			set_mode(0o755);
			eprintln!("skipped: this user may search a directory of mode 000");
			return;
		}
		let run = |args: &[&str]| {
			let (code, capture) = run_util::<Rm>(args, "", cwd.path());
			(code, capture.err())
		};
		let lookups = [&["-f", "locked/x"][..], &["-rf", "locked/x"], &["-r", "locked/x"], &["locked/x"]].map(run);
		let tree = run(&["-rf", "tree"]);
		set_mode(0o755);

		for (args, result) in ["-f", "-rf", "-r", "(none)"].iter().zip(lookups) {
			assert_eq!(result, (1, "rm: cannot remove 'locked/x': Permission denied\n".to_owned()), "{args}");
		}
		assert!(cwd.path().join("locked/x").exists());
		assert_eq!(tree, (1, "rm: cannot remove 'tree/full': Permission denied\n".to_owned()));
		assert!(!cwd.path().join("tree/empty").exists());
		assert!(cwd.path().join("tree/full/f").exists());
	}

	/// GNU rm -f reports a directory it has no file descriptor left to open
	/// or list (EMFILE) under that reason, as it reports every error but a
	/// missing entry, rather than skipping it and then reporting the directory
	/// above as not empty. The open-file limit belongs to the whole process,
	/// so the removal runs in a process of its own.
	#[cfg(target_os = "linux")]
	#[test]
	fn force_reports_a_directory_it_has_no_descriptor_to_open() {
		if !crate::own_process::own_process() {
			return;
		}
		let cwd = tempdir().unwrap();
		// A chain deeper than the descriptors left below: the walk holds one
		// for each level it has entered, and one more while it lists one.
		let deepest = (0..12).fold(cwd.path().join("tree"), |dir, level| dir.join(format!("d{level}")));
		std::fs::create_dir_all(&deepest).unwrap();
		std::fs::write(deepest.join("f"), b"").unwrap();
		let (mut host, capture) = Host::for_test(Rm::NAME, "", cwd.path());
		let rm = Rm::try_parse_from(["rm", "-rf", "tree"]).unwrap();

		// Five descriptors are left below the limit, wherever they are: it is
		// set just above the fifth descriptor not open now. A free one below a
		// descriptor the process inherited counts among the five, so the walk
		// gets five whatever descriptors the harness left open.
		// SAFETY: F_GETFD only reads a descriptor's flags, and fails (EBADF)
		// for one that is not open.
		let open = |fd: libc::c_int| unsafe { libc::fcntl(fd, libc::F_GETFD) } != -1;
		let fifth_free = (0..libc::c_int::MAX).filter(|&fd| !open(fd)).nth(4).unwrap();
		let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
		// SAFETY: getrlimit and setrlimit only read and write `limit`.
		assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) }, 0);
		let saved = limit.rlim_cur;
		limit.rlim_cur = fifth_free as libc::rlim_t + 1;
		// SAFETY: as above.
		assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
		let code = rm.run(&mut host);
		limit.rlim_cur = saved;
		// SAFETY: as above.
		assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);

		let err = capture.err();
		assert_eq!(code, 1, "{err}");
		assert_eq!(err.lines().count(), 1, "{err}");
		let named = err
			.strip_prefix("rm: cannot remove '")
			.and_then(|rest| rest.strip_suffix("': Too many open files\n"));
		assert!(named.is_some_and(|path| path.starts_with("tree/d0/")), "{err}");
		assert!(deepest.join("f").exists(), "the removal went on below the directory it could not open");
	}

	/// GNU rm -f reports a mount point it cannot remove (EBUSY) under that
	/// reason, removes the rest, and leaves the directories above it.
	///
	/// Ignored by default because it needs the privilege to mount: run it as
	/// root, or as root of a user namespace (`unshare -rm`), with `--ignored`.
	/// Without the mount nothing is busy, so a silent early return would
	/// report a pass that proves nothing.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "mounts a tmpfs; run as root with --ignored"]
	fn force_reports_a_mount_point_it_cannot_remove() {
		let cwd = tempdir().unwrap();
		let point = cwd.path().join("tree/point");
		std::fs::create_dir_all(&point).unwrap();
		std::fs::write(cwd.path().join("tree/other"), b"").unwrap();
		let mounted = std::process::Command::new("mount")
			.args(["-t", "tmpfs", "tmpfs"])
			.arg(&point)
			.stderr(std::process::Stdio::null())
			.status()
			.is_ok_and(|status| status.success());
		assert!(mounted, "mount -t tmpfs failed: run this test as root");

		let (code, capture) = run_util::<Rm>(&["-rf", "tree"], "", cwd.path());
		let unmounted = std::process::Command::new("umount").arg(&point).status();

		assert_eq!((code, capture.err().as_str()), (1, "rm: cannot remove 'tree/point': Device or resource busy\n"));
		assert!(point.is_dir());
		assert!(!cwd.path().join("tree/other").exists());
		assert!(unmounted.is_ok_and(|status| status.success()));
	}

	#[cfg(windows)]
	#[test]
	fn removes_directories_with_the_read_only_attribute() {
		let set_read_only = |path: &Path| {
			let mut permissions = std::fs::metadata(path).unwrap().permissions();
			permissions.set_readonly(true);
			std::fs::set_permissions(path, permissions).unwrap();
		};
		for flags in ["-rf", "-r", "-d"] {
			let cwd = tempdir().unwrap();
			let dir = cwd.path().join("dir");
			std::fs::create_dir(&dir).unwrap();
			if flags != "-d" {
				std::fs::write(dir.join("file"), b"").unwrap();
			}
			set_read_only(&dir);

			let (code, capture) = run_util::<Rm>(&[flags, "dir"], "", cwd.path());

			assert_eq!(code, 0, "{flags}: {}", capture.err());
			assert!(!dir.exists(), "{flags}");
		}
	}
}
